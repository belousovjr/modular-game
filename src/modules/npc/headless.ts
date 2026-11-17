import { createCharacterAuthorityFactory, type CharacterSnapshot } from '../characters/headless.ts';
import type { CollisionWorld } from '../world/headless.ts';

export interface Patrol {
  readonly id: string;
  readonly bounds: CollisionWorld['bounds'];
  readonly points: readonly (readonly number[])[];
}
export interface NpcSnapshot { readonly tick: number; readonly actors: readonly CharacterSnapshot[]; readonly arrivals: number }
export const downtownPatrols: readonly Patrol[] = [
  { id:'clark',bounds:{minX:-9,maxX:-3,minZ:-76,maxZ:12},points:[[-7,-70],[-7,-50],[-7,-30],[-7,-10],[-7,8],[-5,8],[-5,-10],[-5,-30],[-5,-50],[-5,-70]] },
  { id:'daley',bounds:{minX:6,maxX:85,minZ:-74,maxZ:-44},points:[[24,-71],[32,-71],[44,-71],[56,-71],[64,-71],[70,-63],[70,-57],[64,-47],[56,-47],[44,-47],[32,-47],[24,-47],[18,-57],[18,-63]] },
];

function navigationBlocked(o:CollisionWorld['blockers'][number],x:number,z:number,radius=.6){
  if(x<=o.minX-radius||x>=o.maxX+radius||z<=o.minZ-radius||z>=o.maxZ+radius)return false;
  if(!o.outline)return true;
  let inside=false;
  for(let i=0,j=o.outline.length-1;i<o.outline.length;j=i++){
    const a=o.outline[j],b=o.outline[i],dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1)));
    if((x-a[0]-dx*t)**2+(z-a[1]-dz*t)**2<radius*radius)return true;
    if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}

// A conservative one-metre planning grid; actual movement/collisions stay in character authority.
function preparePatrol(world: CollisionWorld, patrol: Patrol) {
  const b=patrol.bounds;
  if(!patrol.id.trim()||![b.minX,b.maxX,b.minZ,b.maxZ].every(Number.isSafeInteger)||b.minX>=b.maxX||b.minZ>=b.maxZ||b.minX<world.bounds.minX||b.maxX>world.bounds.maxX||b.minZ<world.bounds.minZ||b.maxZ>world.bounds.maxZ||patrol.points.length<2||patrol.points.length>32)throw new Error('Invalid NPC patrol');
  const width=b.maxX-b.minX+1,depth=b.maxZ-b.minZ+1,size=width*depth;
  if(size>20000)throw new Error('NPC navigation budget exceeded');
  const blockers=world.blockers.filter(o=>o.maxX>=b.minX&&o.minX<=b.maxX&&o.maxZ>=b.minZ&&o.minZ<=b.maxZ);
  const free=new Uint8Array(size);
  const x=(id:number)=>b.minX+id%width,z=(id:number)=>b.minZ+Math.floor(id/width);
  for(let id=0;id<size;id++)free[id]=Number(!blockers.some(o=>navigationBlocked(o,x(id),z(id))));
  const neighbours=(id:number)=>[id%width>0?id-1:-1,id%width<width-1?id+1:-1,id>=width?id-width:-1,id<size-width?id+width:-1].filter(i=>i>=0&&free[i]);
  const points=patrol.points.map(p=>{
    if(p.length!==2||!p.every(Number.isSafeInteger)||p[0]<b.minX||p[0]>b.maxX||p[1]<b.minZ||p[1]>b.maxZ)throw new Error('Invalid NPC waypoint');
    const id=(p[1]-b.minZ)*width+p[0]-b.minX;
    if(!free[id])throw new Error('Blocked NPC waypoint');
    return id;
  });
  if(new Set(points).size!==points.length)throw new Error('Duplicate NPC waypoint');
  const paths=points.map((goal,index)=>{
    const start=points[(index+points.length-1)%points.length];
    const previous=new Int32Array(size).fill(-1),queue=new Int32Array(size);
    let head=0,tail=1;queue[0]=start;previous[start]=start;
    while(head<tail&&previous[goal]<0){const id=queue[head++];for(const next of neighbours(id))if(previous[next]<0){previous[next]=id;queue[tail++]=next;}}
    if(previous[goal]<0)throw new Error('Unreachable NPC waypoint');
    const path:number[]=[];
    for(let id=goal;id!==start;id=previous[id])path.push(id);
    path.reverse();
    // Keep corners, drop intermediate cells along straight runs.
    return path.filter((id,i)=>i===path.length-1||i===0||(x(id)-x(path[i-1]))!==(x(path[i+1])-x(id))||(z(id)-z(path[i-1]))!==(z(path[i+1])-z(id))).map(id=>({x:x(id),z:z(id)}));
  });
  return {points:points.map(id=>({x:x(id),z:z(id)})),paths};
}

export function findPedestrianPath(world:CollisionWorld,start:{readonly x:number;readonly z:number},goal:{readonly x:number;readonly z:number}){
  if(![start.x,start.z,goal.x,goal.z].every(Number.isFinite)||Math.hypot(start.x-goal.x,start.z-goal.z)>24)throw new Error('Invalid pedestrian path');
  const bounds={minX:Math.max(Math.ceil(world.bounds.minX+1),Math.floor(Math.min(start.x,goal.x))-5),maxX:Math.min(Math.floor(world.bounds.maxX-1),Math.ceil(Math.max(start.x,goal.x))+5),minZ:Math.max(Math.ceil(world.bounds.minZ+1),Math.floor(Math.min(start.z,goal.z))-5),maxZ:Math.min(Math.floor(world.bounds.maxZ-1),Math.ceil(Math.max(start.z,goal.z))+5)};
  const nearest=(p:typeof start)=>{
    const candidates=[];
    for(let x=Math.round(p.x)-2;x<=Math.round(p.x)+2;x++)for(let z=Math.round(p.z)-2;z<=Math.round(p.z)+2;z++)if(x>=bounds.minX&&x<=bounds.maxX&&z>=bounds.minZ&&z<=bounds.maxZ&&!world.blockers.some(o=>navigationBlocked(o,x,z)))candidates.push({x,z});
    candidates.sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z));
    if(!candidates.length)throw new Error('Blocked pedestrian path');return candidates[0];
  };
  const clear=(a:typeof start,b:typeof start)=>{
    const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/.15));
    for(let i=0;i<=steps;i++)if(world.blockers.some(o=>navigationBlocked(o,a.x+(b.x-a.x)*i/steps,a.z+(b.z-a.z)*i/steps,.35)))return false;
    return true;
  };
  if(clear(start,goal))return [{x:goal.x,z:goal.z}];
  const a=nearest(start),b=nearest(goal);
  const path=a.x===b.x&&a.z===b.z?[]:preparePatrol(world,{id:'autowalk',bounds,points:[[a.x,a.z],[b.x,b.z]]}).paths[1];
  const candidates=[a,...path,{x:goal.x,z:goal.z}],result:typeof candidates=[];
  let current=start,index=0;
  while(index<candidates.length){let next=candidates.length-1;while(next>=index&&!clear(current,candidates[next]))next--;
    if(next<index)throw new Error('Blocked pedestrian connector');
    result.push(candidates[next]);current=candidates[next];index=next+1;
  }
  return result;
}

export function createNpcAuthority(world: CollisionWorld, patrols: readonly Patrol[], count=8, startTick=0, prefix='npc') {
  if(!Number.isSafeInteger(count)||count<1||count>32||!Number.isSafeInteger(startTick)||startTick<0||!prefix.trim()||patrols.length<1||patrols.length>8||new Set(patrols.map(p=>p.id)).size!==patrols.length)throw new Error('Invalid NPC population');
  const createCharacter=createCharacterAuthorityFactory(world);
  const prepared=patrols.map(p=>preparePatrol(world,p));
  const actors=Array.from({length:count},(_,i)=>{
    const route=prepared[i%prepared.length],point=Math.floor(i/prepared.length);
    if(point>=route.points.length)throw new Error('NPC spawn capacity exceeded');
    return {id:`${prefix}/${i}`,authority:createCharacter(startTick,route.points[point]),route,goal:(point+1)%route.points.length,node:0,waitUntil:startTick,arrivals:0,stalled:0};
  });
  let tick=startTick;
  return {
    step(nextTick:number){
      if(nextTick!==tick+1)throw new Error('NPC ticks must be consecutive');
      tick=nextTick;
      for(const [i,actor] of actors.entries()){
        const s=actor.authority.snapshot();
        let path=actor.route.paths[actor.goal],target=path[actor.node];
        if(target&&Math.hypot(target.x-s.x,target.z-s.z)<.08){
          actor.node++;
          if(actor.node===path.length){actor.arrivals++;actor.goal=(actor.goal+1)%actor.route.paths.length;actor.node=0;actor.waitUntil=tick+(actor.goal%4===0?45+i%3*15:0);}
          path=actor.route.paths[actor.goal];target=path[actor.node];
        }
        const dx=target?target.x-s.x:0,dz=target?target.z-s.z:0,length=Math.hypot(dx,dz);
        const waiting=tick<actor.waitUntil||actor.stalled>=120;
        const receipt=actor.authority.receive({type:'move',characterId:'local-player',sequence:tick,tick:tick-1,x:waiting||!length?0:dx/length,z:waiting||!length?0:dz/length,run:false,jump:false},'local');
        if(!receipt.accepted)throw new Error(`NPC intent rejected: ${receipt.reason}`);
        actor.authority.step(tick);
        actor.stalled=!waiting&&!actor.authority.snapshot().moving?actor.stalled+1:0;
        // shortcut: inaccessible terrain stops this patrol; add terrain-aware replanning before expanding its zones.
        if(actor.stalled>=120)actor.waitUntil=tick+120;
      }
    },
    snapshot():NpcSnapshot{return Object.freeze({tick,actors:Object.freeze(actors.map(a=>Object.freeze({...a.authority.snapshot(),id:a.id,ownerId:'npc'}))),arrivals:actors.reduce((n,a)=>n+a.arrivals,0)});},
  };
}
