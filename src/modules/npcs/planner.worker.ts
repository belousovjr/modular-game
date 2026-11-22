import { createNpcAuthority, createNpcNavigation, crowdCycles, deriveNpcCycle } from './headless.ts';
import { type PlannerData, type PlannerPlan, type PlannerQuery, type PlannerRequest, type PlannerResponse } from './planner-protocol.ts';

type Init = Extract<PlannerRequest,{type:'init'}>;
let init:Init|undefined;
let navigation:ReturnType<typeof createNpcNavigation>|undefined;
let authority:ReturnType<typeof createNpcAuthority>|undefined;
const data:PlannerData[]=[];
let query:PlannerQuery|undefined;
let scheduled=false;
let reply=false;
let failed=false;
let initialOrigin:PlannerQuery['origin']|undefined;
const sent=new Map<string,object>();
const remoteKeys=new Map<string,string>();

const send=(response:PlannerResponse)=>self.postMessage(response);
function fail(cause:unknown) {
  failed=true;
  send({type:'error',error:cause instanceof Error?cause.message:String(cause)});
}

function prepare(start:Init) {
  const chunks=data.flatMap(packet=>packet.kind==='surface'?[{meshes:packet.meshes}]:[]);
  const roads=data.flatMap(packet=>packet.kind==='roads'?[...packet.roads]:[]);
  const crosswalks=data.flatMap(packet=>packet.kind==='crosswalks'?[...packet.crosswalks]:[]);
  const blockers=data.flatMap(packet=>packet.kind==='blockers'?[...packet.blockers]:[]);
  const doors=data.flatMap(packet=>packet.kind==='doors'?[...packet.doors]:[]);
  const interiors=data.flatMap(packet=>packet.kind==='interiors'?[...packet.interiors]:[]);
  data.length=0;
  const nav=createNpcNavigation({...start.map,chunks,roads,trafficLayout:{crosswalks}},
    {spawn:start.spawn,blockers,doors},interiors);
  navigation=nav;
  return createNpcAuthority(nav,0);
}

function publish(current:NonNullable<typeof authority>,target:PlannerQuery) {
  const plans=new Map<string,PlannerPlan>();
  for (const origin of [target.contactOrigin,target.origin]) if (origin) {
    const {x,z}=origin;
    for (const plan of current.presentation(x,z)) {
      const id=plan.seed.id;
      plans.set(id,{kind:'resident',id,plan});
    }
    for (const plan of current.crowdPresentation(x,z)) {
      const id=plan.group.recipe.id;
      plans.set(id,{kind:'crowd',id,plan});
    }
  }
  const removed:string[]=[],added:PlannerPlan[]=[];
  for (const id of sent.keys()) if (!plans.has(id)) {
    removed.push(id);
    sent.delete(id);
  }
  let more=false;
  for (const [id,plan] of plans) {
    const revision=plan.kind==='resident'?plan.plan.seed:plan.plan.group;
    if (sent.get(id)===revision) continue;
    if (added.length>=3) {more=true;break;}
    sent.set(id,revision);
    added.push(plan);
  }
  send({type:'frame',tick:target.tick,population:current.population(),added,removed,more});
}

function pump() {
  scheduled=false;
  if (!query || !authority || failed) return;
  try {
    const limit=performance.now()+7;
    let busy=true;
    for (let work=0;work<8;work++) {
      busy=authority.planNext(query.tick,initialOrigin??null);
      if (!busy || performance.now()>=limit) break;
    }
    if (reply) {
      publish(authority,query);
      reply=false;
    }
    if (busy) queuePump();
  } catch (cause) { fail(cause); }
}
function queuePump() {
  if (scheduled) return;
  scheduled=true;
  setTimeout(pump,0);
}

function remote(frame:Extract<PlannerRequest,{type:'remote'}>['frame']){
  const nav=navigation;
  if(!nav)return;
  const ids=new Set<string>(),added:PlannerPlan[]=[];
  for(const seed of frame.scenarios){
    ids.add(seed.id);
    const key=JSON.stringify(seed);
    if(remoteKeys.get(seed.id)===key)continue;
    const cycle=deriveNpcCycle(nav,seed);
    if(!cycle)throw new Error('Несовместимый маршрут NPC. Сервер: '+seed.navigation+', клиент: '+nav.version);
    remoteKeys.set(seed.id,key);
    added.push({kind:'resident',id:seed.id,plan:{seed,cycle}});
  }
  for(const group of frame.crowds){
    const id=group.recipe.id;ids.add(id);
    const key=JSON.stringify(group);
    if(remoteKeys.get(id)===key)continue;
    const tracks=crowdCycles(nav,group);
    if(!tracks)throw new Error('Несовместимая навигация фоновых NPC');
    remoteKeys.set(id,key);
    added.push({kind:'crowd',id,plan:{group,...tracks}});
  }
  const removed=[...remoteKeys.keys()].filter(id=>!ids.has(id));
  for(const id of removed)remoteKeys.delete(id);
  send({type:'frame',tick:frame.tick,population:frame.population,added,removed,more:false});
}

self.onmessage=({data:message}:MessageEvent<PlannerRequest>)=>{
  if (failed) return;
  if (message.type==='init') {
    init=message;
  } else if (message.type==='data') {
    data.push(...message.batch);
  } else if (message.type==='prepare') {
    if (!init) return;
    try {
      authority=prepare(init);
      send({type:'ready'});
    } catch (cause) { fail(cause); }
  } else if(message.type==='remote'){
    try{remote(message.frame);}
    catch(cause){fail(cause);}
  } else if(message.type==='recover') {
    try {send({type:'recovered',id:message.job.id,token:message.job.token,target:navigation?.recovery(message.job)??null});}
    catch(cause){fail(cause);}
  } else {
    query=message.query;
    initialOrigin??=query.origin??init?.spawn;
    reply=true;
    queuePump();
  }
};
