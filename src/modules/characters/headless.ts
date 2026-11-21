import { createLocalSession, type DeliveryOptions, type Receipt } from '../../simulation/session.ts';
export type { DeliveryOptions, Receipt } from '../../simulation/session.ts';
import { pedestrianBlockers, type CollisionWorld, type CollisionBox, type BuildingInteriorSource } from '../world/headless.ts';
import {createEntranceMotion,createInteriorCollision,type DoorPose} from '../building-interiors/headless.ts';

export type LocomotionMode = 'walk' | 'fly' | 'swim';
export type CharacterStance = 'standing' | 'crouching' | 'prone';
interface LocomotionInput {readonly boost:boolean;readonly lift:number;readonly flight:boolean|null}
export const LOCOMOTION_SPEEDS = Object.freeze({walk:1.8,crouch:1.05,crawl:.65,run:7,sprint:22,fly:25,fastFly:70,swim:3.1,fastSwim:5.2});
export interface MoveCommand { readonly type: 'move'; readonly characterId: string; readonly sequence: number; readonly tick: number; readonly x: number; readonly z: number; readonly run: boolean; readonly jump: boolean; readonly facing?: number | null; readonly locomotion?:LocomotionInput; readonly stance?:CharacterStance }
export interface VehicleCharacterFrame {
  readonly blocker: CollisionBox;
  readonly approach?: {readonly x:number;readonly z:number;readonly yaw:number;readonly vehicleId:string;readonly run:boolean;readonly align:boolean};
  readonly pose: {readonly x:number;readonly y:number;readonly z:number;readonly yaw:number;readonly vehicleId:string;readonly rotation?:readonly number[];readonly animation:'approaching'|'entering'|'driving'|'exiting'|'crawling'} | null;
  readonly release: {readonly x:number;readonly y:number;readonly z:number;readonly yaw:number} | null;
}
export interface CharacterSnapshot {
  readonly entranceDoors?:readonly DoorPose[];
  readonly tick: number; readonly id: string; readonly ownerId: string;
  readonly x: number; readonly y: number; readonly z: number; readonly yaw: number;
  readonly vehicleId?:string;readonly vehicleRotation?:readonly number[];readonly vehicleAnimation?:'approaching'|'entering'|'driving'|'exiting'|'crawling';
  readonly grounded: boolean; readonly verticalSpeed: number; readonly airborneTicks: number; readonly landedTick: number;
  readonly mode: LocomotionMode; readonly stance:CharacterStance; readonly boosted:boolean;
  readonly moving: boolean; readonly running: boolean; readonly lastSequence: number;
}
function validLocomotion(value:unknown):value is LocomotionInput{
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===3
    &&'boost' in value&&typeof value.boost==='boolean'
    &&'lift' in value&&typeof value.lift==='number'&&Number.isFinite(value.lift)&&Math.abs(value.lift)<=1
    &&'flight' in value&&(typeof value.flight==='boolean'||value.flight===null);
}
export class CharacterSpawnBlockedError extends Error {}
const LOCAL_PLAYER={id:'local-player',ownerId:'local'};

const RADIUS = 0.35;
const HEIGHT = {standing:1.8,crouching:1.3,prone:.65};
const CELL = 32;
type Triangle={minX:number;maxX:number;minZ:number;maxZ:number;vertices:readonly number[];denominator:number};
const terrainIndices=new WeakMap<readonly (readonly number[])[],{cells:Map<string,Triangle[]>;entries:number}>();

export function createCharacterAuthority(world: CollisionWorld, startTick = 0) {
  return createCharacterAuthorityFactory(world)(startTick);
}

export function createCharacterAuthorityFactory(world: CollisionWorld, interiorSources:readonly BuildingInteriorSource[] = [],
  interiors=createInteriorCollision(interiorSources)) {
  if (![world.baseHeight, world.slopeX, world.spawn.x, world.spawn.z, world.baseHeight+world.slopeX*world.bounds.minX, world.baseHeight+world.slopeX*world.bounds.maxX, ...Object.values(world.bounds)].every(Number.isFinite) || Math.abs(world.slopeX) > 0.1 || world.bounds.minX >= world.bounds.maxX || world.bounds.minZ >= world.bounds.maxZ || world.blockers.length > 16000 || world.floors.length > 10000) throw new Error('Invalid character world');
  const cells = new Map<string, CollisionBox[]>();
  const floors = new Map<string, (CollisionWorld['floors'][number])[]>();
  let entries = 0;
  function index<T extends { minX: number; maxX: number; minZ: number; maxZ: number }>(map: Map<string, T[]>, item: T) {
    if (![item.minX, item.maxX, item.minZ, item.maxZ].every(Number.isFinite) || item.minX >= item.maxX || item.minZ >= item.maxZ) throw new Error('Invalid collision bounds');
    const minX = Math.floor((item.minX - RADIUS) / CELL), maxX = Math.floor((item.maxX + RADIUS) / CELL);
    const minZ = Math.floor((item.minZ - RADIUS) / CELL), maxZ = Math.floor((item.maxZ + RADIUS) / CELL);
    entries += (maxX - minX + 1) * (maxZ - minZ + 1);
    if (entries > 1000000 || (maxX - minX + 1) * (maxZ - minZ + 1) > 4096 || ![minX,maxX,minZ,maxZ].every(Number.isSafeInteger)) throw new Error('Collision grid budget exceeded');
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const key = `${x}/${z}`; const list = map.get(key);
      if (list) list.push(item); else map.set(key, [item]);
    }
  }
  if ((world.pedestrianWalls?.length??0) > 100000) throw new Error('Too many pedestrian walls');
  for (const b of pedestrianBlockers(world)) {
    if (![b.minY,b.maxY].every(Number.isFinite) || b.maxY <= b.minY) throw new Error('Invalid collision height');
    if(b.outline && (b.outline.length<3||b.outline.length>256||b.outline.some(p=>p.length!==2||!p.every(Number.isFinite))))throw new Error('Invalid collision outline');
    index(cells, Object.freeze({ ...b,outline:b.outline?.map(p=>Object.freeze([...p])) }));
  }
  for (const f of world.floors) {
    if (!Number.isFinite(f.elevation) || f.elevation < 0 || f.elevation > 10) throw new Error('Invalid floor');
    index(floors, Object.freeze({ ...f }));
  }
  function indexTriangles(source:readonly (readonly number[])[]|undefined) {
    const map=new Map<string,Triangle[]>();
    if(!source)return map;
    const cached=terrainIndices.get(source);
    if(cached){
      entries+=cached.entries;
      if(entries>1000000)throw new Error('Collision grid budget exceeded');
      return cached.cells;
    }
    if(source.length>350000)throw new Error('Too many terrain triangles');
    const firstEntry=entries;
    let immutable=Object.isFrozen(source);
    for(const p of source){
      if(p.length!==9||!p.every(Number.isFinite))throw new Error('Invalid terrain triangle');
      const frozen=Object.isFrozen(p);
      immutable&&=frozen;
      const denominator=(p[5]-p[8])*(p[0]-p[6])+(p[6]-p[3])*(p[2]-p[8]);
      if(Math.abs(denominator)<1e-10)continue;
      const minX=Math.min(p[0],p[3],p[6]),maxX=Math.max(p[0],p[3],p[6]);
      const minZ=Math.min(p[2],p[5],p[8]),maxZ=Math.max(p[2],p[5],p[8]);
      index(map,{minX,maxX,minZ,maxZ,vertices:frozen?p:Object.freeze([...p]),denominator});
    }
    if(immutable)terrainIndices.set(source,{cells:map,entries:entries-firstEntry});
    return map;
  }
  const triangles=indexTriangles(world.triangles);
  const waterLevel=world.water?.level??-Infinity;
  if(world.water&&!Number.isFinite(waterLevel))throw new Error('Invalid water level');
  const waterTriangles=indexTriangles(world.water?.triangles);
  const bounds = { ...world.bounds }, baseHeight = world.baseHeight, slopeX = world.slopeX;
  const query = <T>(map: Map<string, T[]>, x: number, z: number) => map.get(`${Math.floor(x / CELL)}/${Math.floor(z / CELL)}`) ?? [];
  function triangleHeight({vertices:p,denominator}:Triangle,x:number,z:number){
    const a=((p[5]-p[8])*(x-p[6])+(p[6]-p[3])*(z-p[8]))/denominator;
    const b=((p[8]-p[2])*(x-p[6])+(p[0]-p[6])*(z-p[8]))/denominator;
    return a>=-1e-7&&b>=-1e-7&&a+b<=1+1e-7?a*p[1]+b*p[4]+(1-a-b)*p[7]:-Infinity;
  }
  function ground(x: number, z: number, ceiling=Infinity) {
    let elevation = 0;
    for (const f of query(floors,x,z)) if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ) elevation = Math.max(elevation, f.elevation);
    let height=baseHeight+slopeX*x+elevation;
    if(height>ceiling)height=-Infinity;
    for(const triangle of query(triangles,x,z)){
      const sample=triangleHeight(triangle,x,z);
      if(sample<=ceiling)height=Math.max(height,sample);
    }
    return height;
  }
  const overWater=(x:number,z:number)=>query(waterTriangles,x,z).some(t=>triangleHeight(t,x,z)>-Infinity);
  const swimY=waterLevel-1.08;
  const deepWater=(x:number,z:number)=>overWater(x,z)&&ground(x,z,waterLevel)<swimY-.2;
  const defaultSpawn={...world.spawn};
  return (startTick=0,spawn=defaultSpawn,resume?:{x:number;y:number;z:number})=>{
  const {id,ownerId:owner}=LOCAL_PLAYER;
  if(![spawn.x,spawn.z].every(Number.isFinite))throw new Error('Invalid character spawn');
  if(!Number.isSafeInteger(startTick)||startTick<0)throw new Error('Invalid character tick');
  let tick = startTick, x = spawn.x, z = spawn.z, y = ground(x,z), yaw = 0;
  let lastSequence = 0, acceptedTick = -1, expiry = startTick, dx = 0, dz = 0, run = false, facing:number|null = null;
  let mode:LocomotionMode='walk',boost=false,lift=0,flightRequest:boolean|null=null;
  let stance:CharacterStance='standing',stanceRequest:CharacterStance|undefined;
  let vx=0,vy=0,vz=0;
  const entrances=interiorSources.length ? createEntranceMotion(world.doors??[]) : undefined;
  let vehicleFrame:VehicleCharacterFrame|null=null;
  let traffic:readonly CollisionBox[]=[];
  let closed=false;
  function sample(px:number,pz:number,low:number,high:number) {
    return interiors.at(px,pz,low,high);
  }
  function support(px: number,pz: number) {
    let height=ground(px,pz);
    const area=sample(px,pz,y-.5,y+.3);
    for(const slab of area.slabs) if(slab.maxY<=y+.3)height=Math.max(height,slab.maxY);
    for(const b of obstacles(px,pz,y,area.boxes)) {
      const radius=b.id==='stair-tread' ? 0 : area.onStairs ? .215 : RADIUS;
      if(b.maxY<=y+.3 && overlapsAt(b,px,pz,radius))height=Math.max(height,b.maxY);
    }
    return height;
  }
  const obstacles=(px:number,pz:number,py:number,inside:readonly CollisionBox[])=>[
    ...query(cells,px,pz),...inside,...(entrances?.at(px,pz,py)??[]),...(vehicleFrame ? [vehicleFrame.blocker] : []),...traffic,
  ];
  let moving = false, grounded = true, verticalSpeed = 0, airborneTicks = 0, landedTick = -100, jump = false;
  function touches(b:CollisionBox,px:number,pz:number,radius=RADIUS) {
    if(!b.outline)return true;
    let inside=false;
    for(let i=0,j=b.outline.length-1;i<b.outline.length;j=i++) {
      const a=b.outline[j],c=b.outline[i];
      if((a[1]>pz)!==(c[1]>pz)&&px<(c[0]-a[0])*(pz-a[1])/(c[1]-a[1])+a[0])inside=!inside;
      const dx=c[0]-a[0],dz=c[1]-a[1],t=Math.max(0,Math.min(1,((px-a[0])*dx+(pz-a[1])*dz)/(dx*dx+dz*dz||1)));
      if((px-a[0]-dx*t)**2+(pz-a[1]-dz*t)**2<radius*radius)return true;
    }
    return inside;
  }
  function overlapsAt(b:CollisionBox,px:number,pz:number,radius:number){
    return px>=b.minX-radius && px<=b.maxX+radius && pz>=b.minZ-radius && pz<=b.maxZ+radius && touches(b,px,pz,radius);
  }
  function blocked(px: number, pz: number, py: number, checkStep=true,height=HEIGHT[stance]) {
    if (px < bounds.minX + RADIUS || px > bounds.maxX - RADIUS || pz < bounds.minZ + RADIUS || pz > bounds.maxZ - RADIUS || (checkStep&&py-y>.3)) return true;
    const area=sample(px,pz,py,py+height);
    if(area.slabs.some(s=>py<s.maxY-1e-7&&py+height>s.minY+1e-7))return true;
    const radius=area.onStairs ? .215 : RADIUS;
    return obstacles(px,pz,py,area.boxes).some(b=>
      py < b.maxY-1e-7 && py+height > b.minY+1e-7 && overlapsAt(b,px,pz,b.id==='stair-tread'&&checkStep?0:radius));
  }
  function groundedBlocked(px:number,pz:number){
    const floor=support(px,pz);
    return blocked(px,pz,y-floor>.3?y:floor);
  }
  function freeBlocked(px:number,pz:number,py:number){
    if(blocked(px,pz,py,false))return true;
    const top=ground(px,pz);
    if(top<=py+1e-7)return false;
    // Bridge decks are ceilings below their deck, while dry terrain is solid beneath its surface.
    if(!overWater(px,pz))return true;
    return ground(px,pz,py+HEIGHT[stance]-1e-7)>py+1e-7;
  }
  function resetMotion(){
    mode='walk';vx=vy=vz=0;boost=false;lift=0;flightRequest=null;
  }
  function freeStep(hasInput:boolean){
    const swim=mode==='swim';
    const speed=swim?(boost&&hasInput?LOCOMOTION_SPEEDS.fastSwim:LOCOMOTION_SPEEDS.swim)
      :(boost&&hasInput?LOCOMOTION_SPEEDS.fastFly:LOCOMOTION_SPEEDS.fly);
    const inputX=hasInput?dx:0,inputZ=hasInput?dz:0,inputY=hasInput?lift:0;
    const length=Math.max(1,Math.hypot(inputX,inputY,inputZ));
    const targetX=inputX*speed/length,targetZ=inputZ*speed/length;
    const targetY=swim&&inputY===0?Math.max(-1.7,Math.min(2,(swimY-y)*5)):inputY*speed/length;
    const changeX=targetX-vx,changeY=targetY-vy,changeZ=targetZ-vz;
    const limit=(swim?22:(inputX||inputY||inputZ)?105:145)/60;
    const scale=Math.min(1,limit/(Math.hypot(changeX,changeY,changeZ)||1));
    vx+=changeX*scale;vy+=changeY*scale;vz+=changeZ*scale;
    const steps=Math.max(1,Math.ceil(Math.hypot(vx,vy,vz)/60/.22));
    const beforeX=x,beforeY=y,beforeZ=z;
    for(let i=0;i<steps;i++){
      const nx=x+vx/(steps*60),nz=z+vz/(steps*60),ny=y+vy/(steps*60);
      if(vx){if(freeBlocked(nx,z,y))vx=0;else x=nx;}
      if(vz){if(freeBlocked(x,nz,y))vz=0;else z=nz;}
      if(vy){
        const capped=swim?Math.min(ny,swimY):Math.min(ny,800);
        if(freeBlocked(x,z,capped)){
          if(!swim&&vy<0){mode='walk';vx=vy=vz=0;break;}
          vy=0;
        }else{y=capped;if(capped!==ny)vy=0;}
      }
    }
    grounded=false;
    verticalSpeed=(y-beforeY)*60;
    const moveX=x-beforeX,moveZ=z-beforeZ;
    moving=Math.hypot(moveX,swim&&inputY===0?0:y-beforeY,moveZ)>.00015;
    if(hasInput&&facing!==null)yaw=facing;
    else if(Math.hypot(moveX,moveZ)>.00015)yaw=Math.atan2(moveX,moveZ);
    if(swim&&!deepWater(x,z)){
      resetMotion();
      const top=ground(x,z);
      if(top>=y-.3&&top<=y+.3){y=top;grounded=true;}
    }
  }
  if (interiorSources.length) {
    for(const slab of sample(x,z,y-.03,y+.3).slabs) {
      if(slab.maxY>=y && slab.maxY<=y+.03)y=slab.maxY;
    }
  }
  const initialPosition={x,y,z};
  if (resume && [resume.x,resume.y,resume.z].every(Number.isFinite) && Math.abs(resume.y)<=10000) {
    let savedY=resume.y;
    for(const slab of sample(resume.x,resume.z,savedY,savedY+.03).slabs) {
      if(slab.maxY>=savedY&&slab.maxY<=savedY+.03)savedY=slab.maxY;
    }
    if(!freeBlocked(resume.x,resume.z,savedY)&&Number.isFinite(ground(resume.x,resume.z,savedY+1e-7))){
      x=resume.x;y=savedY;z=resume.z;
      grounded=Math.abs(y-support(x,z))<1e-7;
    }
  }
  if (blocked(x,z,y)) throw new CharacterSpawnBlockedError('Character spawn is blocked');
  return {
    dispose(){
      if(closed)return;
      closed=true;
    },
    resetPosition(){
      if(closed)throw new Error('Character authority disposed');
      const start=initialPosition;
      traffic=[];
      if(blocked(start.x,start.z,start.y,false,HEIGHT.standing))throw new Error('Стартовая точка персонажа занята');
      x=start.x;y=start.y;z=start.z;yaw=0;
      dx=dz=0;run=false;facing=null;expiry=tick;stance='standing';stanceRequest=undefined;
      grounded=true;moving=false;jump=false;verticalSpeed=0;airborneTicks=0;landedTick=-100;
      resetMotion();
      if(vehicleFrame)vehicleFrame={blocker:vehicleFrame.blocker,pose:null,release:null};
    },
    setTrafficBlockers(blockers:readonly CollisionBox[]) {traffic=blockers;},
    setVehicleFrame(frame:VehicleCharacterFrame|null){
      if(frame){
        if(frame.approach&&(![frame.approach.x,frame.approach.z,frame.approach.yaw].every(Number.isFinite)||!frame.approach.vehicleId.trim()))throw new Error('Invalid vehicle approach');
        if(![frame.blocker.minX,frame.blocker.maxX,frame.blocker.minZ,frame.blocker.maxZ,frame.blocker.minY,frame.blocker.maxY].every(Number.isFinite)||frame.blocker.minX>=frame.blocker.maxX||frame.blocker.minZ>=frame.blocker.maxZ||frame.blocker.minY>=frame.blocker.maxY)throw new Error('Invalid vehicle frame');
        for(const pose of [frame.pose,frame.release])if(pose&&![pose.x,pose.y,pose.z,pose.yaw].every(Number.isFinite))throw new Error('Invalid vehicle pose');
        const pose=frame.pose??frame.release;
        if(pose){x=pose.x;y=pose.y;z=pose.z;yaw=pose.yaw;verticalSpeed=0;grounded=true;jump=false;dx=dz=0;stance='standing';stanceRequest=undefined;resetMotion();}
      }
      if(vehicleFrame?.approach&&!frame?.approach&&!frame?.pose){dx=dz=0;run=false;facing=null;expiry=tick;}
      vehicleFrame=frame;
    },
    receive(input: unknown, ownerId: string): Receipt {
      if(closed)return {accepted:false,reason:'closed'};
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('type' in input) || !('characterId' in input) || !('sequence' in input) || !('tick' in input) || !('x' in input) || !('z' in input) || !('run' in input) || !('jump' in input) || Object.keys(input).length !== (8+Number('facing' in input)+Number('locomotion' in input)+Number('stance' in input)) || input.type !== 'move' || input.characterId !== id || typeof input.sequence !== 'number' || !Number.isSafeInteger(input.sequence) || input.sequence <= 0 || typeof input.tick !== 'number' || !Number.isSafeInteger(input.tick) || input.tick < 0 || typeof input.x !== 'number' || typeof input.z !== 'number' || ![input.x,input.z].every(Number.isFinite) || Math.abs(input.x) > 1 || Math.abs(input.z) > 1 || typeof input.run !== 'boolean' || typeof input.jump !== 'boolean' || ('facing' in input && input.facing !== null && (typeof input.facing !== 'number' || !Number.isFinite(input.facing) || Math.abs(input.facing)>Math.PI))) return { accepted: false, reason: 'invalid' };
      const locomotion='locomotion' in input?input.locomotion:undefined;
      if('locomotion' in input&&!validLocomotion(locomotion))return {accepted:false,reason:'invalid'};
      let requestedStance:CharacterStance|undefined;
      if('stance' in input){
        const value=input.stance;
        if(value!=='standing'&&value!=='crouching'&&value!=='prone')return {accepted:false,reason:'invalid'};
        requestedStance=value;
      }
      if (vehicleFrame?.pose||vehicleFrame?.approach) return {accepted:false,reason:'vehicle'};
      if (ownerId !== owner) return { accepted: false, reason: 'owner' };
      if (input.sequence <= lastSequence) return { accepted: false, reason: 'sequence' };
      if (input.tick > tick || tick-input.tick > 30) return { accepted: false, reason: 'stale' };
      if (acceptedTick === tick) return { accepted: false, reason: 'rate' };
      lastSequence = input.sequence; acceptedTick = tick; expiry = tick + 12;
      stanceRequest=requestedStance;
      const length = Math.max(1, Math.hypot(input.x,input.z));
      dx = input.x / length; dz = input.z / length; run = input.run; jump = input.jump && grounded; facing='facing' in input && typeof input.facing==='number'?input.facing:null;
      if(validLocomotion(locomotion)){
        boost=locomotion.boost;lift=locomotion.lift;
        if(locomotion.flight!==null)flightRequest=locomotion.flight;
      }else{boost=false;lift=0;}
      return { accepted: true, reason: 'accepted' };
    },
    step(nextTick: number) {
      if(closed)throw new Error('Character authority disposed');
      if (nextTick !== tick + 1) throw new Error('Character ticks must be consecutive');
      tick = nextTick;
      moving = false;
      if(entrances){
        const blockers=(door:NonNullable<CollisionWorld['doors']>[number])=>[
          ...query(cells,door.x,door.z).filter(box=>!box.id.startsWith(`${door.id}/wall/`)),
          ...sample(door.x,door.z,door.y,door.y+door.height).boxes,
          ...(vehicleFrame ? [vehicleFrame.blocker] : []),
        ];
        entrances.step(vehicleFrame?.pose ? null : {x,y,z},RADIUS,HEIGHT[stance],blockers);
      }
      if(vehicleFrame?.pose)return;
      if(vehicleFrame?.approach){resetMotion();stanceRequest='standing';const a=vehicleFrame.approach,tx=a.x-x,tz=a.z-z,length=Math.hypot(tx,tz);const scale=Math.min(1,length*60/(a.run?7:1.8));dx=length>.01?tx/length*scale:0;dz=length>.01?tz/length*scale:0;run=a.run;facing=a.align?a.yaw:null;jump=false;expiry=tick+1;}
      if(stanceRequest&&stanceRequest!==stance&&grounded&&mode==='walk'&&!blocked(x,z,y,false,HEIGHT[stanceRequest]))stance=stanceRequest;
      stanceRequest=undefined;
      if(flightRequest!==null){
        if(flightRequest&&mode!=='fly'&&(stance==='standing'||!blocked(x,z,y,false,HEIGHT.standing))){
          const takeoff=grounded&&lift>=0;
          mode='fly';stance='standing';vx=vz=0;vy=takeoff?8:0;verticalSpeed=0;grounded=false;airborneTicks=12;
        }
        else if(!flightRequest&&mode==='fly'){resetMotion();verticalSpeed=0;airborneTicks=12;}
        flightRequest=null;
      }
      if(mode==='walk'&&y<=swimY&&deepWater(x,z)){mode='swim';stance='standing';grounded=false;vx=vy=vz=0;}
      if(mode!=='walk'){jump=false;freeStep(tick<=expiry);return;}
      if (jump && grounded && stance==='standing') { verticalSpeed = 5.5; grounded = false; airborneTicks = 0; }
      jump = false;
      const speed=stance==='prone'?LOCOMOTION_SPEEDS.crawl:stance==='crouching'?LOCOMOTION_SPEEDS.crouch:boost?LOCOMOTION_SPEEDS.sprint:run?LOCOMOTION_SPEEDS.run:LOCOMOTION_SPEEDS.walk;
      if (tick <= expiry) {
        // Swept movement is subdivided below the radius, then slides along each axis.
        const steps = Math.max(1, Math.ceil(Math.hypot(dx,dz)*speed / 60 / 0.1));
        const beforeX = x, beforeZ = z;
        for (let i = 0; i < steps; i++) {
          const nx = x + dx * speed / 60 / steps;
          if(dx&&!(grounded?groundedBlocked(nx,z):freeBlocked(nx,z,y)))x=nx;
          const nz = z + dz * speed / 60 / steps;
          if(dz&&!(grounded?groundedBlocked(x,nz):freeBlocked(x,nz,y)))z=nz;
          if (grounded) {
            const floor=support(x,z);
            if(y-floor>.3){grounded=false;airborneTicks=0;}
            else y=floor;
          }
        }
        moving = Math.hypot(x-beforeX,z-beforeZ) > 1e-8;
        if (stance!=='prone'&&facing!==null) yaw=facing;
        else if (moving) yaw = stance==='prone'?Math.atan2(x-beforeX,z-beforeZ):Math.atan2(dx,dz);
      }
      if (!grounded) {
        airborneTicks++;
        verticalSpeed -= 16 / 60;
        let nextY = y + verticalSpeed / 60;
        let support=ground(x,z,overWater(x,z)?y+.3:Infinity);
        const height=HEIGHT[stance];
        const area=sample(x,z,Math.min(y,nextY),Math.max(y,nextY)+height);
        for(const slab of area.slabs){
          if(verticalSpeed<=0&&y>=slab.maxY-1e-7)support=Math.max(support,slab.maxY);
          if(verticalSpeed>0&&y+height<=slab.minY+1e-7&&nextY+height>=slab.minY){
            nextY=slab.minY-height;verticalSpeed=0;
          }
        }
        for (const b of obstacles(x,z,y,area.boxes)) {
          const radius=b.id==='stair-tread'?0:area.onStairs?.215:RADIUS;
          if(!overlapsAt(b,x,z,radius))continue;
          if (verticalSpeed <= 0 && y >= b.maxY-1e-8) support = Math.max(support,b.maxY);
          if (verticalSpeed > 0 && y+height <= b.minY && nextY+height >= b.minY) { nextY=b.minY-height;verticalSpeed=0; }
        }
        if (nextY <= support) { nextY=support;verticalSpeed=0;grounded=true;landedTick=tick; }
        y=nextY;
      }
    },
    snapshot(): CharacterSnapshot { return Object.freeze({ tick, ...(entrances?{entranceDoors:entrances.snapshot()}:{}), id, ownerId:owner, x,y,z,yaw,grounded,verticalSpeed,airborneTicks,landedTick,mode,stance,boosted:moving&&stance==='standing'&&boost&&tick<=expiry,moving,running: moving&&stance==='standing'&&(run||boost),lastSequence,...(vehicleFrame?.approach?{vehicleId:vehicleFrame.approach.vehicleId,vehicleAnimation:'approaching' as const}:{}),...(vehicleFrame?.pose?{vehicleId:vehicleFrame.pose.vehicleId,vehicleAnimation:vehicleFrame.pose.animation,...(vehicleFrame.pose.rotation?{vehicleRotation:Object.freeze([...vehicleFrame.pose.rotation])}:{})}:{}) }); },
  };
  };
}

export function createLocalConnection(
  authority: ReturnType<typeof createCharacterAuthority>, options: DeliveryOptions = {}, session = createLocalSession(),
) {
  const { id, ownerId } = authority.snapshot();
  const channel = session.connect<MoveCommand, CharacterSnapshot>(
    id, authority.snapshot, command => authority.receive(command, ownerId), options,
  );
  return {
    send: channel.send, snapshot: channel.snapshot, close: channel.close,
    step(tick: number) {
      channel.deliver(tick);
      authority.step(tick);
      channel.publish();
    },
    resetPosition() {
      authority.resetPosition();
      channel.clear('reset');
      channel.publish();
    },
  };
}
