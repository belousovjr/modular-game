import { Pool } from 'pg';
import { createNpcAuthority, createNpcNavigation, createTrafficActors, crowdTiming, crowdTrack,
  NPC_RADIUS, TRAFFIC_RADIUS, type TrafficActor, type TrafficRecovery } from '../src/modules/npcs/headless.ts';
import type { CharacterSnapshot } from '../src/modules/characters/headless.ts';
import type { TrafficPoint } from '../src/simulation/traffic.ts';
import { readNpcCheckpoint, type NpcFrame } from '../src/simulation/online-protocol.ts';

type Observer = Pick<CharacterSnapshot,'x'|'z'>;

export async function createRoomNpcs(nav:ReturnType<typeof createNpcNavigation>, room:string, url?:string) {
  const pool=url?new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,query_timeout:10000}):undefined;
  pool?.on('error',()=>console.error('NPC storage connection failed'));
  let authority=createNpcAuthority(nav,0);
  let offset=0, wrecks:NpcFrame['corrections']=[];
  try {
    const saved=await pool?.query<{state:unknown}>(
      'SELECT state FROM public.world_npc_checkpoints WHERE room_id=$1 AND navigation=$2',[room,nav.version]);
    if(saved?.rows.length){
      const state=readNpcCheckpoint(saved.rows[0].state,nav.version);
      if(!state)throw new Error('Invalid world NPC checkpoint');
      authority.restore(state);
      offset=state.tick;
      wrecks=state.wrecks;
    }
  } catch(error) {
    await pool?.end();
    throw error;
  }
  let current=offset, observers:readonly Observer[]=[], savedRevision=authority.revision();
  let writing:Promise<void>|undefined;
  let resetting:Promise<void>|undefined;
  const recovery:TrafficRecovery[]=[];
  const makeTraffic=()=>createTrafficActors(job=>recovery.push(job),true);
  let traffic=makeTraffic();
  for(const {id,pose} of wrecks){
    const actor=authority.resident(id);
    if(actor)traffic.restoreWreck(actor,pose);
  }
  let savedWrecks=JSON.stringify(wrecks);
  const inRange=(hero:Observer,point:TrafficPoint,radius:number)=>Math.hypot(hero.x-point[0],hero.z-point[2])<=radius;
  // The server cannot see the camera frustum. Keep wrecks outside every possible player camera before retiring them.
  const hidden=(point:TrafficPoint)=>!observers.some(hero=>inRange(hero,point,TRAFFIC_RADIUS+18));
  async function save(source:typeof authority,wrecks:NpcFrame['corrections']){
    await pool?.query(
      `INSERT INTO public.world_npc_checkpoints(room_id,navigation,state) VALUES($1,$2,$3::jsonb)
       ON CONFLICT(room_id,navigation) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`,
      [room,nav.version,JSON.stringify({...source.checkpoint(),tick:current,wrecks})],
    );
  }
  function checkpoint(){
    if(writing||!pool||resetting)return writing;
    const wrecks=traffic.settledWrecks();
    const serialized=JSON.stringify(wrecks);
    if(savedRevision===authority.revision()&&savedWrecks===serialized)return;
    const revision=authority.revision();
    writing=save(authority,wrecks).then(()=>{savedRevision=revision;savedWrecks=serialized;}).finally(()=>{writing=undefined;});
    return writing;
  }
  // Route search and SQL run outside the fixed-step callback.
  const planner=setInterval(()=>{
    if(resetting)return;
    const job=recovery.shift();
    if(job)traffic.rejoin(job.id,job.token,nav.recovery(job));
    else authority.planNext(current,nav.spawn,hidden,traffic.immobilized);
  },25);
  const saving=setInterval(()=>{
    void checkpoint()?.catch(()=>console.error('Could not save NPC checkpoint'));
  },30_000);
  return {
    population:()=>authority.population(),
    reset(){
      resetting??=(async()=>{
        await writing?.catch(()=>{});
        const fresh=createNpcAuthority(nav,current);
        await save(fresh,[]);
        authority=fresh;
        traffic=makeTraffic();
        recovery.length=0;
        savedRevision=fresh.revision();
        savedWrecks='[]';
      })().finally(()=>{resetting=undefined;});
      return resetting;
    },
    snapshot(hero:Observer){
      const area=authority.observe(hero.x,hero.z,current);
      const deviations=traffic.corrections();
      const overridden=new Set(deviations.map(({id})=>id));
      const corrections=deviations.filter(({pose})=>inRange(hero,pose.point,(pose.mode==='drive'?TRAFFIC_RADIUS:NPC_RADIUS)+8));
      const visible=new Set(corrections.map(({id})=>id));
      const groups=new Set(area.crowds.map(group=>group.recipe.id));
      const suppressed=[...overridden].filter(id=>!visible.has(id)&&groups.has(id.split('/crowd/')[0]));
      return {...area,population:authority.population(),scenarios:area.scenarios.filter(seed=>!overridden.has(seed.id)),corrections,suppressed};
    },
    get tick(){return current;},
    step(tick:number,heroes:readonly Observer[],car:TrafficPoint){
      current=offset+tick;
      authority.syncTick(current);
      observers=heroes;
      if(tick%6===1){
        const residents=new Map<string,TrafficActor>();
        const groups=new Set<string>();
        for(const {x,z} of [...heroes,{x:car[0],z:car[2]}]){
          for(const {seed,cycle} of authority.presentation(x,z,32))residents.set(seed.id,{id:seed.id,cycle});
          for(const {group,full,outdoors} of authority.crowdPresentation(x,z,32)){
            if(groups.has(group.recipe.id))continue;
            groups.add(group.recipe.id);
            for(let slot=0;slot<group.count;slot++){
              const cycle=crowdTrack(full,outdoors,group,slot);
              const id=`${group.recipe.id}/crowd/${slot}`;
              residents.set(id,{id,cycle,...crowdTiming(cycle,group,slot)});
            }
          }
        }
        traffic.replace([...residents.values()]);
      }
      traffic.advance(current);
      traffic.pruneWrecks(current,point=>!hidden(point)||inRange({x:car[0],z:car[2]},point,16),authority.retire);
    },
    get traffic(){return traffic;},
    async close(){
      clearInterval(planner);
      clearInterval(saving);
      try {
        await resetting?.catch(()=>{});
        await writing?.catch(()=>{});
        await checkpoint();
      } finally {await pool?.end();}
    },
  };
}
export type RoomNpcs=Awaited<ReturnType<typeof createRoomNpcs>>;
