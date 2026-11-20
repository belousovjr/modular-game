import pathfinding from 'javascript-astar';
import { CharacterSpawnBlockedError, createCharacterAuthorityFactory, LOCOMOTION_SPEEDS, type CharacterIdentity, type CharacterSnapshot, type MoveCommand } from '../characters/headless.ts';
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

type Waypoint={readonly x:number;readonly z:number};
type NavigationBox=CollisionWorld['blockers'][number];
type Bounds=CollisionWorld['bounds'];

function segmentClear(blockers:readonly NavigationBox[],a:Waypoint,b:Waypoint,radius:number){
  const steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/.125));
  for(let i=0;i<=steps;i++){
    if(blockers.some(box=>navigationBlocked(box,a.x+(b.x-a.x)*i/steps,a.z+(b.z-a.z)*i/steps,radius)))return false;
  }
  return true;
}

function createGrid(bounds:Bounds, obstacles:readonly NavigationBox[], cell:number, radius:number){
  const width=Math.floor((bounds.maxX-bounds.minX)/cell)+1,depth=Math.floor((bounds.maxZ-bounds.minZ)/cell)+1;
  const size=width*depth;
  if(width<1||depth<1||size>20000)throw new Error('NPC navigation budget exceeded');
  const blockers=obstacles.filter(box=>box.maxX>=bounds.minX-radius&&box.minX<=bounds.maxX+radius&&
    box.maxZ>=bounds.minZ-radius&&box.minZ<=bounds.maxZ+radius);
  const point=(id:number):Waypoint=>({x:bounds.minX+(id%width)*cell,z:bounds.minZ+Math.floor(id/width)*cell});
  const free=new Uint8Array(size);
  for(let id=0;id<size;id++){
    const {x,z}=point(id);
    free[id]=Number(!blockers.some(box=>navigationBlocked(box,x,z,radius)));
  }
  const graph=new pathfinding.Graph(Array.from({length:width},(_,x)=>
    Array.from({length:depth},(_,z)=>free[z*width+x])));
  const index=(node:{x:number;y:number})=>node.y*width+node.x;
  const neighbors=graph.neighbors.bind(graph);
  graph.neighbors=node=>neighbors(node).filter(next=>free[index(next)]&&
    segmentClear(blockers,point(index(node)),point(index(next)),radius));
  function find(start:number,goal:number):Waypoint[]|undefined{
    if(start===goal)return [];
    const node=(id:number)=>graph.grid[id%width][Math.floor(id/width)];
    const startNode=node(start);
    const path=pathfinding.astar.search(graph,startNode,node(goal)).map(index);
    // The library closes the start node without adding it to the dirty list.
    graph.markDirty(startNode);
    if(!path.length)return undefined;
    return path.filter((id,i)=>i===path.length-1||id-(path[i-1]??start)!==path[i+1]-id).map(point);
  }
  return {width,size,free,point,find};
}

function preparePatrol(world: CollisionWorld, patrol: Patrol) {
  const b=patrol.bounds;
  if(!patrol.id.trim()||![b.minX,b.maxX,b.minZ,b.maxZ].every(Number.isSafeInteger)||b.minX>=b.maxX||b.minZ>=b.maxZ||b.minX<world.bounds.minX||b.maxX>world.bounds.maxX||b.minZ<world.bounds.minZ||b.maxZ>world.bounds.maxZ||patrol.points.length<2||patrol.points.length>32)throw new Error('Invalid NPC patrol');
  const grid=createGrid(b,world.blockers,1,.6);
  const points=patrol.points.map(p=>{
    if(p.length!==2||!p.every(Number.isSafeInteger)||p[0]<b.minX||p[0]>b.maxX||p[1]<b.minZ||p[1]>b.maxZ)throw new Error('Invalid NPC waypoint');
    const id=(p[1]-b.minZ)*grid.width+p[0]-b.minX;
    if(!grid.free[id])throw new Error('Blocked NPC waypoint');
    return id;
  });
  if(new Set(points).size!==points.length)throw new Error('Duplicate NPC waypoint');
  const paths=points.map((goal,index)=>{
    const path=grid.find(points[(index+points.length-1)%points.length],goal);
    if(!path)throw new Error('Unreachable NPC waypoint');
    return path;
  });
  return {points:points.map(grid.point),paths};
}

function localPath(bounds:Bounds,blockers:readonly NavigationBox[],start:Waypoint,goal:Waypoint,cell:number){
  const radius=.35;
  const clear=(a:Waypoint,b:Waypoint)=>segmentClear(blockers,a,b,radius);
  if(clear(start,goal))return [goal];
  if(!clear(start,start)||!clear(goal,goal))return undefined;
  const grid=createGrid(bounds,blockers,cell,radius);
  function nearest(endpoint:Waypoint){
    let best=-1,distance=Infinity;
    for(let id=0;id<grid.size;id++){
      if(!grid.free[id])continue;
      const point=grid.point(id),d=Math.hypot(point.x-endpoint.x,point.z-endpoint.z);
      if(d<distance&&clear(endpoint,point)){best=id;distance=d;}
    }
    return best;
  }
  const a=nearest(start),b=nearest(goal);
  if(a<0||b<0)return undefined;
  const path=grid.find(a,b);
  if(!path)return undefined;
  const candidates=[grid.point(a),...path,goal],result:Waypoint[]=[];
  let current=start,index=0;
  while(index<candidates.length){
    let next=candidates.length-1;
    while(next>=index&&!clear(current,candidates[next]))next--;
    if(next<index)return undefined;
    result.push(candidates[next]);current=candidates[next];index=next+1;
  }
  return result;
}

export function findPedestrianPath(world:CollisionWorld,start:Waypoint,goal:Waypoint){
  const inside=({x,z}:Waypoint)=>x>=world.bounds.minX+.35&&x<=world.bounds.maxX-.35&&
    z>=world.bounds.minZ+.35&&z<=world.bounds.maxZ-.35;
  if(!inside(start)||!inside(goal)||Math.hypot(start.x-goal.x,start.z-goal.z)>24)throw new Error('Invalid pedestrian path');
  const path=localPath(localBounds(world.bounds,start,goal,5),world.blockers,start,goal,1);
  if(!path)throw new Error('Blocked pedestrian path');
  return path;
}

function localBounds(world:Bounds,start:Waypoint,goal:Waypoint,margin:number):Bounds{
  return {minX:Math.max(Math.ceil(world.minX+.35),Math.floor(Math.min(start.x,goal.x))-margin),
    maxX:Math.min(Math.floor(world.maxX-.35),Math.ceil(Math.max(start.x,goal.x))+margin),
    minZ:Math.max(Math.ceil(world.minZ+.35),Math.floor(Math.min(start.z,goal.z))-margin),
    maxZ:Math.min(Math.floor(world.maxZ-.35),Math.ceil(Math.max(start.z,goal.z))+margin)};
}

function pedestrianMove(s:CharacterSnapshot,target:Waypoint|undefined):MoveCommand{
  const dx=target?target.x-s.x:0,dz=target?target.z-s.z:0;
  const distance=Math.hypot(dx,dz);
  const desired=distance?Math.atan2(dx,dz):s.yaw;
  const turn=Math.atan2(Math.sin(desired-s.yaw),Math.cos(desired-s.yaw));
  const yaw=s.yaw+Math.max(-.12,Math.min(.12,turn));
  const speedScale=Math.max(0,Math.cos(turn))/Math.max(distance,LOCOMOTION_SPEEDS.walk/60);
  return {type:'move',characterId:s.id,sequence:s.lastSequence+1,tick:s.tick,x:dx*speedScale,z:dz*speedScale,
    run:false,jump:false,facing:Math.atan2(Math.sin(yaw),Math.cos(yaw))};
}

type CreatePedestrian = (tick:number,spawn:{x:number;z:number},identity:CharacterIdentity)=>
  ReturnType<ReturnType<typeof createCharacterAuthorityFactory>>;

export function createNpcAuthority(world: CollisionWorld, patrols: readonly Patrol[], count=8, startTick=0, prefix='npc',
  createPedestrian?:CreatePedestrian) {
  if(!Number.isSafeInteger(count)||count<1||count>32||!Number.isSafeInteger(startTick)||startTick<0||!prefix.trim()||patrols.length<1||patrols.length>8||new Set(patrols.map(p=>p.id)).size!==patrols.length)throw new Error('Invalid NPC population');
  const prepared=patrols.map(p=>preparePatrol(world,p));
  if(!createPedestrian){
    const factory=createCharacterAuthorityFactory(world);
    createPedestrian=(tick,spawn,identity)=>factory(tick,spawn,undefined,identity);
  }
  const create=createPedestrian;
  const nextSpawn=prepared.map(()=>0);
  function spawnActor(index:number){
    const zone=index%prepared.length,route=prepared[zone];
    const identity={id:`${prefix}/${index}`,ownerId:prefix};
    while(nextSpawn[zone]<route.points.length){
      const point=nextSpawn[zone]++;
      try {
        const authority=create(startTick,route.points[point],identity);
        const detour:Waypoint[]=[];
        return {authority,route,goal:(point+1)%route.points.length,node:0,waitUntil:startTick,arrivals:0,stalled:0,detour,nextPlan:startTick};
      } catch(error) {
        if(!(error instanceof CharacterSpawnBlockedError))throw error;
      }
    }
    throw new Error('NPC spawn capacity exceeded');
  }
  const actors:ReturnType<typeof spawnActor>[]=[];
  const dispose=()=>{for(const actor of actors.splice(0))actor.authority.dispose();};
  try {
    for(let i=0;i<count;i++)actors.push(spawnActor(i));
  } catch(error) {
    dispose();
    throw error;
  }
  let tick=startTick;
  return {
    dispose,
    step(nextTick:number){
      if(nextTick!==tick+1)throw new Error('NPC ticks must be consecutive');
      tick=nextTick;
      for(const [i,actor] of actors.entries()){
        const s=actor.authority.snapshot();
        let path=actor.route.paths[actor.goal],target=path[actor.node];
        while(actor.detour.length&&Math.hypot(actor.detour[0].x-s.x,actor.detour[0].z-s.z)<.08)actor.detour.shift();
        if(!actor.detour.length&&target&&Math.hypot(target.x-s.x,target.z-s.z)<.08){
          actor.node++;
          if(actor.node===path.length){
            actor.arrivals++;actor.goal=(actor.goal+1)%actor.route.paths.length;actor.node=0;
            actor.waitUntil=tick+(actor.goal%4===0?45+i%3*15:0);
          }
          path=actor.route.paths[actor.goal];target=path[actor.node];
        }
        let steering:Waypoint|undefined=actor.detour[0]??target;
        if(tick<actor.waitUntil)steering=undefined;
        if(steering&&target){
          const obstacles=actor.authority.navigationObstacles();
          const dx=steering.x-s.x,dz=steering.z-s.z,scale=Math.min(1,2.5/(Math.hypot(dx,dz)||1));
          const ahead={x:s.x+dx*scale,z:s.z+dz*scale};
          if(!segmentClear(obstacles,s,ahead,.35)){
            steering=undefined;
            if(tick>=actor.nextPlan){
              actor.nextPlan=tick+12+i%3;
              const dx=target.x-s.x,dz=target.z-s.z,scale=Math.min(1,5/(Math.hypot(dx,dz)||1));
              const rejoin={x:s.x+dx*scale,z:s.z+dz*scale};
              const bounds=localBounds(world.bounds,s,rejoin,2);
              const staticBoxes=world.blockers.filter(box=>box.maxY>s.y+.3&&box.minY<s.y+1.8&&
                box.maxX>=bounds.minX-.35&&box.minX<=bounds.maxX+.35&&box.maxZ>=bounds.minZ-.35&&box.minZ<=bounds.maxZ+.35);
              actor.detour=localPath(bounds,[...staticBoxes,...obstacles],s,rejoin,.25)??[];
              steering=actor.detour[0];
            }
          }
        }
        const command=pedestrianMove(s,steering);
        const receipt=actor.authority.receive(command,s.ownerId);
        if(!receipt.accepted)throw new Error(`NPC intent rejected: ${receipt.reason}`);
        actor.authority.step(tick);
        const after=actor.authority.snapshot();
        const progress=steering?Math.hypot(steering.x-s.x,steering.z-s.z)-Math.hypot(steering.x-after.x,steering.z-after.z):0;
        actor.stalled=steering&&progress<.003&&Math.abs(command.x)+Math.abs(command.z)>.1 ? actor.stalled+1 : 0;
        // shortcut: if the collision solver sees an obstacle outside the planar map, wait and retry.
        if(actor.stalled>=120)actor.waitUntil=tick+120;
      }
    },
    snapshot():NpcSnapshot{return Object.freeze({tick,actors:Object.freeze(actors.map(a=>a.authority.snapshot())),arrivals:actors.reduce((n,a)=>n+a.arrivals,0)});},
  };
}
