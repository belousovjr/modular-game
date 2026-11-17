import {World,Body,Box,ConvexPolyhedron,Material,ContactMaterial,Vec3,Heightfield,RaycastVehicle,SAPBroadphase} from 'cannon-es';
import {createCharacterAuthorityFactory,type CharacterSnapshot,type VehicleCharacterFrame,type Receipt,type DeliveryOptions} from '../characters/headless.ts';
import {findPedestrianPath} from '../npc/headless.ts';
import type {CollisionBox,CollisionWorld} from '../world/headless.ts';

interface Base {readonly vehicleId:string;readonly characterId:string;readonly sequence:number;readonly tick:number}
export type VehicleCommand = (Base & {readonly type:'enter'|'exit'}) | (Base & {readonly type:'door';readonly side:'left'|'right'}) | (Base & {readonly type:'drive';readonly throttle:number;readonly steer:number;readonly brake:boolean});
export interface VehicleSnapshot {
  readonly id:string;readonly tick:number;readonly position:readonly number[];readonly rotation:readonly number[];
  readonly wheels:readonly {readonly position:readonly number[];readonly rotation:readonly number[]}[];
  readonly speed:number;readonly steering:number;readonly driverId:string|null;readonly phase:'parked'|'approaching'|'entering'|'driving'|'exiting';
  readonly leftDoor:number;readonly rightDoor:number;readonly message:string;
}
// Interaction guides belong to this vehicle model; ticks match its retargeted car clips.
export const CAR_GUIDES={
  id:'compact-suv',height:2.3,stand:{x:-1.7,z:-.35},seat:{x:-.46,y:.47,z:-.12},
  enter:{duration:110,open:[18,36],close:[80,104],move:[39,75],lift:[53,60]},
  exit:{duration:117,movingDuration:59,movingMove:[15,55],open:[3,21],close:[72,90],move:[30,71],drop:[38,45]},
} as const;
const ID='car/0',TILE=32,STEP=2,ROOT_OFFSET=.65;
const ramp=(tick:number,pair:readonly [number,number])=>{const x=Math.max(0,Math.min(1,(tick-pair[0])/(pair[1]-pair[0])));return x*x*(3-2*x);};
// Convex compounds preserve facade recesses without triangle-mesh collision or render LOD dependencies.
function buildingShapes(b:CollisionBox){
  const height=b.maxY-b.minY;
  if(!b.outline)return [{shape:new Box(new Vec3((b.maxX-b.minX)/2,height/2,(b.maxZ-b.minZ)/2)),offset:new Vec3()}];
  const cross=(a:readonly number[],c:readonly number[],d:readonly number[])=>(c[0]-a[0])*(d[1]-c[1])-(c[1]-a[1])*(d[0]-c[0]);
  const points=b.outline.map(p=>[p[0]-(b.minX+b.maxX)/2,p[1]-(b.minZ+b.maxZ)/2]);
  for(let i=points.length-1;i>=0&&points.length>3;i--)if(Math.abs(cross(points[(i+points.length-1)%points.length],points[i],points[(i+1)%points.length]))<1e-8)points.splice(i,1);
  const area=points.reduce((sum,p,i)=>sum+p[0]*points[(i+1)%points.length][1]-p[1]*points[(i+1)%points.length][0],0);
  if(Math.abs(area)<1e-8)throw new Error('Degenerate building collider');
  if(area<0)points.reverse();
  const convex=(ids:number[])=>ids.every((id,i)=>cross(points[id],points[ids[(i+1)%ids.length]],points[ids[(i+2)%ids.length]])>=-1e-8);
  const remaining=points.map((_,i)=>i),parts:number[][]=[];
  if(convex(remaining))parts.push([...remaining]);
  else{
    while(remaining.length>3){let clipped=false;
      for(let i=0;i<remaining.length;i++){
        const a=remaining[(i+remaining.length-1)%remaining.length],c=remaining[i],d=remaining[(i+1)%remaining.length];
        if(cross(points[a],points[c],points[d])<=1e-8)continue;
        if(remaining.some(id=>id!==a&&id!==c&&id!==d&&cross(points[a],points[c],points[id])>=-1e-8&&cross(points[c],points[d],points[id])>=-1e-8&&cross(points[d],points[a],points[id])>=-1e-8))continue;
        parts.push([a,c,d]);remaining.splice(i,1);clipped=true;break;
      }
      if(!clipped)throw new Error('Invalid building collision polygon');
    }
    parts.push(remaining);
    // Merge neighbouring ears when their union stays convex; fewer shapes enter narrow phase.
    for(let i=0;i<parts.length;i++)for(let j=i+1;j<parts.length;j++){
      const a=parts[i],c=parts[j];let merged:number[]|null=null;
      for(let u=0;u<a.length&&!merged;u++)for(let v=0;v<c.length;v++)if(a[u]===c[(v+1)%c.length]&&a[(u+1)%a.length]===c[v]){
        const candidate=Array.from({length:a.length},(_,k)=>a[(u+1+k)%a.length]).concat(Array.from({length:c.length-2},(_,k)=>c[(v+2+k)%c.length]));
        if(convex(candidate))merged=candidate;
      }
      if(merged){parts[i]=merged;parts.splice(j,1);i=-1;break;}
    }
  }
  return parts.map(ids=>{
    const n=ids.length,cx=ids.reduce((sum,id)=>sum+points[id][0],0)/n,cz=ids.reduce((sum,id)=>sum+points[id][1],0)/n;
    const vertices=[-height/2,height/2].flatMap(y=>ids.map(id=>new Vec3(points[id][0]-cx,y,points[id][1]-cz)));
    return {shape:new ConvexPolyhedron({vertices,faces:[ids.map((_,i)=>i),ids.map((_,i)=>2*n-1-i),...ids.map((_,i)=>[i+n,(i+1)%n+n,(i+1)%n,i])]}),offset:new Vec3(cx,0,cz)};
  });
}
export function createVehicleAuthority(collision:CollisionWorld,startTick=0){
  if(!Number.isSafeInteger(startTick)||startTick<0)throw new Error('Invalid vehicle tick');
  const probe=createCharacterAuthorityFactory(collision);
  const triangles=new Map<string,(readonly number[])[]>();
  for(const t of collision.triangles??[]){
    for(let x=Math.floor(Math.min(t[0],t[3],t[6])/TILE);x<=Math.floor(Math.max(t[0],t[3],t[6])/TILE);x++)for(let z=Math.floor(Math.min(t[2],t[5],t[8])/TILE);z<=Math.floor(Math.max(t[2],t[5],t[8])/TILE);z++){
      const key=`${x}/${z}`,list=triangles.get(key)??[];list.push(t);triangles.set(key,list);
    }
  }
  function ground(x:number,z:number){
    let y=collision.baseHeight+collision.slopeX*x;
    for(const f of collision.floors)if(x>=f.minX&&x<=f.maxX&&z>=f.minZ&&z<=f.maxZ)y=Math.max(y,collision.baseHeight+collision.slopeX*x+f.elevation);
    for(const p of triangles.get(`${Math.floor(x/TILE)}/${Math.floor(z/TILE)}`)??[]){
      const den=(p[5]-p[8])*(p[0]-p[6])+(p[6]-p[3])*(p[2]-p[8]);if(Math.abs(den)<1e-9)continue;
      const a=((p[5]-p[8])*(x-p[6])+(p[6]-p[3])*(z-p[8]))/den,b=((p[8]-p[2])*(x-p[6])+(p[0]-p[6])*(z-p[8]))/den;
      if(a>=-1e-7&&b>=-1e-7&&a+b<=1+1e-7)y=Math.max(y,a*p[1]+b*p[4]+(1-a-b)*p[7]);
    }
    return y;
  }
  const physics=new World({gravity:new Vec3(0,-9.81,0),allowSleep:true});physics.broadphase=new SAPBroadphase(physics);
  physics.defaultContactMaterial.friction=.12;physics.defaultContactMaterial.restitution=.42;
  const chassisMaterial=new Material('vehicle/chassis'),terrainMaterial=new Material('vehicle/terrain');
  physics.addContactMaterial(new ContactMaterial(chassisMaterial,terrainMaterial,{friction:.04,restitution:.03}));
  const body=new Body({material:chassisMaterial,mass:1100,linearDamping:.035,angularDamping:.25,sleepSpeedLimit:.05,sleepTimeLimit:1});
  // Bevel the underside overhangs so the collision bumper rides over small terrain crests.
  body.addShape(new ConvexPolyhedron({vertices:[new Vec3(-1.012,-.18,-1.25),new Vec3(1.012,-.18,-1.25),new Vec3(1.012,.403,-2.128),new Vec3(-1.012,.403,-2.128),new Vec3(-1.012,-.18,1.25),new Vec3(1.012,-.18,1.25),new Vec3(1.012,.403,2.128),new Vec3(-1.012,.403,2.128)],faces:[[3,2,1,0],[4,5,6,7],[5,4,0,1],[2,3,7,6],[0,4,7,3],[1,2,6,5]]}));body.addShape(new Box(new Vec3(.863,.633,.978)),new Vec3(0,.805,-.23));
  body.position.set(collision.spawn.x+3.5,ground(collision.spawn.x+3.5,collision.spawn.z+1)+.7,collision.spawn.z+1);
  const car=new RaycastVehicle({chassisBody:body,indexRightAxis:0,indexUpAxis:1,indexForwardAxis:2});
  for(const z of [1.34,-1.351])for(const x of [-.928,.928])car.addWheel({radius:.43,directionLocal:new Vec3(0,-1,0),axleLocal:new Vec3(-1,0,0),chassisConnectionPointLocal:new Vec3(x,.12,z),suspensionRestLength:.4,suspensionStiffness:18,dampingRelaxation:2.8,dampingCompression:3.2,frictionSlip:2.8,rollInfluence:.12,maxSuspensionForce:18000,maxSuspensionTravel:.28,isFrontWheel:z>0});
  car.addToWorld(physics);for(let i=0;i<4;i++)car.updateWheelTransform(i);
  const bounds=collision.bounds;
  const barriers=[
    {id:'vehicle-boundary/west',minX:bounds.minX-2,maxX:bounds.minX,minZ:bounds.minZ-2,maxZ:bounds.maxZ+2,minY:-100,maxY:1000},
    {id:'vehicle-boundary/east',minX:bounds.maxX,maxX:bounds.maxX+2,minZ:bounds.minZ-2,maxZ:bounds.maxZ+2,minY:-100,maxY:1000},
    {id:'vehicle-boundary/south',minX:bounds.minX-2,maxX:bounds.maxX+2,minZ:bounds.minZ-2,maxZ:bounds.minZ,minY:-100,maxY:1000},
    {id:'vehicle-boundary/north',minX:bounds.minX-2,maxX:bounds.maxX+2,minZ:bounds.maxZ,maxZ:bounds.maxZ+2,minY:-100,maxY:1000},
  ];
  const terrain=new Map<string,Body>(),obstacles=new Map<string,Body>();let region='';
  function syncTerrain(){
    const ix=Math.floor(body.position.x/TILE),iz=Math.floor(body.position.z/TILE),key=`${ix}/${iz}`;if(region===key)return;region=key;
    const wanted=new Set<string>();
    for(let tx=ix-1;tx<=ix+1;tx++)for(let tz=iz-1;tz<=iz+1;tz++){
      const id=`${tx}/${tz}`;wanted.add(id);if(terrain.has(id))continue;
      const heights=Array.from({length:TILE/STEP+1},(_,x)=>Array.from({length:TILE/STEP+1},(_,z)=>ground(tx*TILE+x*STEP,(tz+1)*TILE-z*STEP)));
      const floor=new Body({mass:0,material:terrainMaterial});floor.addShape(new Heightfield(heights,{elementSize:STEP}));floor.position.set(tx*TILE,0,(tz+1)*TILE);floor.quaternion.setFromEuler(-Math.PI/2,0,0);physics.addBody(floor);terrain.set(id,floor);
    }
    for(const [id,b] of terrain)if(!wanted.has(id)){physics.removeBody(b);terrain.delete(id);}
    const keep=new Set<string>();
    for(const b of [...collision.blockers,...barriers]){
      if(b.maxX<(ix-1)*TILE||b.minX>(ix+2)*TILE||b.maxZ<(iz-1)*TILE||b.minZ>(iz+2)*TILE)continue;
      keep.add(b.id);if(obstacles.has(b.id))continue;
      const obstacle=new Body({mass:0});for(const {shape,offset} of buildingShapes(b))obstacle.addShape(shape,offset);obstacle.position.set((b.maxX+b.minX)/2,(b.maxY+b.minY)/2,(b.maxZ+b.minZ)/2);physics.addBody(obstacle);obstacles.set(b.id,obstacle);
    }
    for(const[id,b]of obstacles)if(!keep.has(id)){physics.removeBody(b);obstacles.delete(id);}
  }
  let tick=startTick,sequence=0,acceptedTick=-1,expires=startTick,throttle=0,steering=0,steeringAngle=0,brake=true;
  let phase:VehicleSnapshot['phase']='parked',since=startTick,driverId:string|null=null,message='';
  let leftDoor=0,rightDoor=0,leftOpen=false,rightOpen=false;
  let approachPath:{x:number;z:number}[]=[],approachNode=0,lastProgress=startTick,lastDistance=Infinity;
  let character:CharacterSnapshot|null=null,entry={x:0,y:0,z:0,yaw:0},exit={x:0,y:0,z:0,yaw:0},release:VehicleCharacterFrame['release']=null;
  let coasting=false;
  const point=(x:number,y:number,z:number)=>{const v=body.quaternion.vmult(new Vec3(x,y-ROOT_OFFSET,z));return {x:v.x+body.position.x,y:v.y+body.position.y,z:v.z+body.position.z};};
  const heading=()=>{const v=body.quaternion.vmult(new Vec3(0,0,1));return Math.atan2(v.x,v.z);};
  const speed=()=>body.velocity.length();
  const denied=(reason:string):Receipt=>{message=reason;return {accepted:false,reason};};
  function carBlocker(){
    const p=body.position,c=Math.cos(heading()),sn=Math.sin(heading());
    const outline=[[-1.15,-2.45],[1.15,-2.45],[1.15,2.45],[-1.15,2.45]].map(([x,z])=>[p.x+x*c+z*sn,p.z-x*sn+z*c]);
    return {id:ID,minX:Math.min(...outline.map(p=>p[0])),maxX:Math.max(...outline.map(p=>p[0])),minZ:Math.min(...outline.map(p=>p[1])),maxZ:Math.max(...outline.map(p=>p[1])),minY:p.y-ROOT_OFFSET,maxY:p.y-ROOT_OFFSET+CAR_GUIDES.height,outline};
  }
  function standingPoint(){const p=point(CAR_GUIDES.stand.x,0,CAR_GUIDES.stand.z),s=probe(tick,{x:p.x,z:p.z}).snapshot();return {x:s.x,y:s.y,z:s.z,yaw:heading()-Math.PI/2};}
  function safeExit(){try{const p=standingPoint();return p;}catch{return null;}}
  function snapshot():VehicleSnapshot{return Object.freeze({id:ID,tick,position:Object.freeze(Object.values(point(0,0,0))),rotation:Object.freeze([body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w]),wheels:Object.freeze(car.wheelInfos.map(w=>{const t=w.worldTransform;return Object.freeze({position:Object.freeze([t.position.x,t.position.y,t.position.z]),rotation:Object.freeze([t.quaternion.x,t.quaternion.y,t.quaternion.z,t.quaternion.w])});})),speed:speed(),steering:steeringAngle,driverId,phase,leftDoor,rightDoor,message});}
  return {
    observeCharacter(s:CharacterSnapshot){character=s;},
    receive(value:unknown,owner:string):Receipt{
      if(!value||typeof value!=='object'||Array.isArray(value))return denied('invalid');
      const input:Record<string,unknown>=Object.fromEntries(Object.entries(value));
      if(owner!=='local')return denied('owner');
      if(input.vehicleId!==ID||input.characterId!=='local-player'||!Number.isSafeInteger(input.sequence)||typeof input.sequence!=='number'||input.sequence<=0||typeof input.tick!=='number'||!Number.isSafeInteger(input.tick)||input.tick<0)return denied('invalid');
      if(input.sequence<=sequence)return denied('sequence');if(input.tick>tick||tick-input.tick>30)return denied('stale');if(acceptedTick===tick)return denied('rate');
      const type=input.type;
      const keys=type==='drive'?['type','vehicleId','characterId','sequence','tick','throttle','steer','brake']:type==='door'?['type','vehicleId','characterId','sequence','tick','side']:['type','vehicleId','characterId','sequence','tick'];
      if(Object.keys(input).length!==keys.length||Object.keys(input).some(k=>!keys.includes(k))||!['drive','enter','exit','door'].includes(String(type)))return denied('invalid');
      if(type==='drive'&&(typeof input.throttle!=='number'||typeof input.steer!=='number'||![input.throttle,input.steer].every(Number.isFinite)||Math.abs(input.throttle)>1||Math.abs(input.steer)>1||typeof input.brake!=='boolean'))return denied('invalid');
      if(type==='door'&&input.side!=='left'&&input.side!=='right')return denied('invalid');
      if(type==='enter'||type==='door'){
        if(!character||phase!=='parked'||speed()>.6||!character.grounded)return denied('unavailable');
        const door=type==='enter'?body.position:point(input.side==='right'?1.9:-1.9,0,-.05);if(Math.hypot(character.x-door.x,character.y-door.y,character.z-door.z)>(type==='enter'?6.5:2.6))return denied('too-far');
      }else if(driverId!==input.characterId)return denied('driver');
      if(type==='enter'){
        try{const stand=standingPoint();approachPath=findPedestrianPath({...collision,blockers:[...collision.blockers,carBlocker()]},character!,stand);}
        catch{return denied('blocked-door');}
        approachNode=0;lastProgress=tick;lastDistance=Infinity;phase='approaching';coasting=false;since=tick;driverId='local-player';leftOpen=rightOpen=false;
      }
      if(type==='exit'){
        if(phase==='approaching'){phase='parked';driverId=null;approachPath=[];}
        else{
          if(phase!=='driving')return denied('unavailable');const p=safeExit();if(!p)return denied('blocked-exit');exit=p;since=tick;leftOpen=rightOpen=false;throttle=steering=0;brake=true;
          coasting=speed()>.6;phase='exiting';
        }
      }
      if(type==='door'){if(input.side==='left')leftOpen=!leftOpen;else rightOpen=!rightOpen;}
      if(type==='drive'){
        if(phase!=='driving')return denied('unavailable');throttle=typeof input.throttle==='number'?input.throttle:0;steering=typeof input.steer==='number'?input.steer:0;brake=input.brake===true;expires=tick+12;body.wakeUp();
      }
      sequence=input.sequence;acceptedTick=tick;message='';return {accepted:true,reason:'accepted'};
    },
    step(nextTick:number,s:CharacterSnapshot):VehicleCharacterFrame{
      if(nextTick!==tick+1)throw new Error('Vehicle ticks must be consecutive');tick=nextTick;character=s;release=null;syncTerrain();
      if(tick>expires){throttle=steering=0;brake=true;}
      if(phase==='approaching'){
        const target=approachPath[approachNode],distance=target?Math.hypot(s.x-target.x,s.z-target.z):0;
        if(distance<lastDistance-.005){lastDistance=distance;lastProgress=tick;}
        if(target&&distance<.08){approachNode++;lastDistance=Infinity;lastProgress=tick;}
        if(approachNode>=approachPath.length&&leftDoor<.01){
          try{const p=standingPoint();if(Math.hypot(p.x-s.x,p.z-s.z)>.15)throw new Error('Car moved');entry={...p,y:s.y,yaw:heading()};phase='entering';since=tick;}
          catch{phase='parked';driverId=null;message='blocked-door';}
        }else if(tick-lastProgress>120||tick-since>600){phase='parked';driverId=null;message='blocked-door';}
      }
      const elapsed=tick-since;
      if(phase==='entering'&&elapsed>=CAR_GUIDES.enter.duration){phase='driving';leftOpen=false;rightOpen=false;}
      const forward=body.quaternion.vmult(new Vec3(0,0,1)),velocity=body.velocity.dot(forward);
      if(coasting&&phase==='parked'&&speed()<.5)coasting=false;
      const braking=coasting?false:phase!=='driving'||brake;
      if(throttle===0&&!braking){
        const v=Math.hypot(body.velocity.x,body.velocity.z);
        if(v>1e-6){const force=body.mass*Math.min(v*60,.9+.002*v*v)/v;body.applyForce(new Vec3(-body.velocity.x*force,0,-body.velocity.z*force));}
      }
      const targetSteering=-steering*.55/(1+(Math.abs(velocity)/11)**3);
      steeringAngle+=Math.max(-2.4/60,Math.min(2.4/60,targetSteering-steeringAngle));
      for(let i=0;i<4;i++){car.setSteeringValue(i<2?steeringAngle:0,i);car.setBrake(braking?80:0,i);car.applyEngineForce(!braking&&(throttle>=0?velocity<40:velocity>-9)?-throttle*1900:0,i);}
      if(body.sleepState!==Body.SLEEPING||phase==='driving')physics.step(1/60);
      if(phase!=='driving'&&tick-startTick>120&&speed()<.18&&car.wheelInfos.filter(w=>w.isInContact).length>=3)body.sleep();
      if(phase==='exiting'){
        const target=safeExit();
        if(!target){phase='driving';coasting=false;brake=true;message='blocked-exit';}
        else{exit=target;if(elapsed>=(coasting?CAR_GUIDES.exit.movingDuration:CAR_GUIDES.exit.duration)){phase='parked';driverId=null;leftOpen=coasting;rightOpen=false;release=exit;}}
      }
      for(let i=0;i<4;i++)car.updateWheelTransform(i);
      leftDoor+=Math.max(-.06,Math.min(.06,Number(leftOpen)*1.15-leftDoor));rightDoor+=Math.max(-.06,Math.min(.06,Number(rightOpen)*1.15-rightDoor));
      if(phase==='entering')leftDoor=1.15*ramp(elapsed,CAR_GUIDES.enter.open)*(1-ramp(elapsed,CAR_GUIDES.enter.close));
      if(phase==='exiting')leftDoor=1.15*ramp(elapsed,CAR_GUIDES.exit.open)*(coasting?1:1-ramp(elapsed,CAR_GUIDES.exit.close));
      const blocker=carBlocker();
      let pose:VehicleCharacterFrame['pose']=null;
      let approach:VehicleCharacterFrame['approach'];
      if(phase==='approaching'){
        const p=approachPath[approachNode]??approachPath.at(-1);
        if(p)approach={x:p.x,z:p.z,yaw:heading()+Math.PI/2,vehicleId:ID,run:Math.hypot(s.x-approachPath.at(-1)!.x,s.z-approachPath.at(-1)!.z)>2.5,align:Math.hypot(s.x-approachPath.at(-1)!.x,s.z-approachPath.at(-1)!.z)<.08};
      }else if(driverId){
        const seat=point(CAR_GUIDES.seat.x,CAR_GUIDES.seat.y,CAR_GUIDES.seat.z),entering=phase==='entering',exiting=phase==='exiting';
        const a=entering?ramp(elapsed,CAR_GUIDES.enter.move):exiting?ramp(elapsed,coasting?CAR_GUIDES.exit.movingMove:CAR_GUIDES.exit.move):1;
        const from=entering?entry:seat,to=exiting?exit:seat;
        let y=seat.y;
        if(entering){const lift=ramp(elapsed,CAR_GUIDES.enter.lift);const footCorrection=.1*ramp(elapsed,[45,53]);y=(entry.y+footCorrection)*(1-lift)+seat.y*lift;}
        if(exiting){const compensation=.15*(1-ramp(elapsed,coasting?[45,55]:[45,100]));const drop=ramp(elapsed,CAR_GUIDES.exit.drop);y=seat.y*(1-drop)+(exit.y+compensation)*drop;}
        pose={...(phase==='driving'?{rotation:[body.quaternion.x,body.quaternion.y,body.quaternion.z,body.quaternion.w]}:{}),x:from.x+(to.x-from.x)*a,y,z:from.z+(to.z-from.z)*a,yaw:heading(),vehicleId:ID,animation:entering?'entering':exiting?'exiting':'driving'};
      }
      return {blocker,pose,release,...(approach?{approach}:{})};
    },snapshot,
    dispose(){car.removeFromWorld(physics);for(const b of [...terrain.values(),...obstacles.values()])physics.removeBody(b);terrain.clear();obstacles.clear();},
  };
}

export function createVehicleConnection(authority:ReturnType<typeof createVehicleAuthority>,options:DeliveryOptions={}){
  const latency=options.latencyTicks??0,jitter=options.jitterTicks??0,drop=options.dropEvery??0;let seed=options.seed??2026,count=0,closed=false;
  if(![latency,jitter,drop,seed].every(Number.isSafeInteger)||latency<0||latency>120||jitter<0||jitter>120||drop<0||seed<0||seed>0xffffffff)throw new Error('Invalid vehicle delivery');
  const queue:{due:number;command:VehicleCommand;resolve:(r:Receipt)=>void}[]=[];
  return {send(command:VehicleCommand):Promise<Receipt>{
    if(closed)return Promise.resolve({accepted:false,reason:'closed'});if(queue.length>=64)return Promise.resolve({accepted:false,reason:'queue'});
    count++;if(drop&&count%drop===0)return Promise.resolve({accepted:false,reason:'dropped'});seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const due=authority.snapshot().tick+1+latency+Math.floor(seed/0x100000000*(jitter*2+1))-jitter;
    return new Promise(resolve=>queue.push({due,command:{...command},resolve}));
  },step(tick:number,character:CharacterSnapshot){authority.observeCharacter(character);queue.sort((a,b)=>a.due-b.due);while(queue.length&&queue[0].due<=tick){const packet=queue.shift();if(packet)packet.resolve(authority.receive(packet.command,'local'));}return authority.step(tick,character);},snapshot:authority.snapshot,close(){closed=true;for(const p of queue.splice(0))p.resolve({accepted:false,reason:'closed'});}};
}
