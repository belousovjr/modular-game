import {findPedestrianPath} from '../src/modules/npc/headless.ts';
import {Quaternion,Vec3} from 'cannon-es';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createVehicleAuthority,createVehicleConnection,CAR_GUIDES,type VehicleCommand} from '../src/modules/vehicles/headless.ts';
import {createCharacterAuthority} from '../src/modules/characters/headless.ts';
import type {CollisionWorld} from '../src/modules/world/headless.ts';
import {createLocalAuthority} from '../src/simulation/authority.ts';
const world:CollisionWorld={bounds:{minX:-100,maxX:100,minZ:-100,maxZ:100},baseHeight:0,slopeX:0,spawn:{x:0,z:0},blockers:[],floors:[]};
const cmd=(type:'enter'|'exit',tick:number,sequence=tick):VehicleCommand=>({type,vehicleId:'car/0',characterId:'local-player',sequence,tick});
const drive=(tick:number,throttle=1,steer=0,brake=false):VehicleCommand=>({type:'drive',vehicleId:'car/0',characterId:'local-player',sequence:tick,tick:tick-1,throttle,steer,brake});
function session(w=world){const car=createVehicleAuthority(w),actor=createCharacterAuthority(w);let tick=0;return {car,actor,advance(to:number,command?:(tick:number)=>void){while(tick<to){tick++;command?.(tick);actor.setVehicleFrame(car.step(tick,actor.snapshot()));actor.step(tick);}},get tick(){return tick;}};}
function board(s:ReturnType<typeof session>){s.advance(120);assert.equal(s.car.receive(cmd('enter',120),'local').accepted,true);while(s.car.snapshot().phase!=='driving'&&s.tick<650)s.advance(s.tick+1);assert.equal(s.car.snapshot().phase,'driving');}

test('vehicle authority owns boarding, animated doors, driving, braking and safe exit',()=>{
  const s=session();try{
    s.advance(120);const initial=s.car.snapshot();assert.ok(Math.abs(initial.position[1])<.12);
    assert.equal(s.car.receive(cmd('enter',120),'local').accepted,true);assert.equal(s.car.snapshot().phase,'approaching');
    while(s.car.snapshot().phase==='approaching'&&s.tick<400)s.advance(s.tick+1);const animationStart=s.tick;
    assert.equal(s.car.snapshot().phase,'entering');assert.equal(s.car.snapshot().leftDoor,0);
    s.advance(animationStart+10);assert.equal(s.car.snapshot().leftDoor,0,'Door opened before the hand reached its handle');
    s.advance(animationStart+30);assert.ok(s.car.snapshot().leftDoor>.7);assert.equal(s.actor.snapshot().vehicleAnimation,'entering');
    s.advance(animationStart+CAR_GUIDES.enter.duration);assert.equal(s.actor.snapshot().vehicleId,'car/0');assert.equal(s.actor.snapshot().vehicleAnimation,'driving');
    assert.equal(s.actor.receive({type:'move',characterId:'local-player',sequence:1,tick:339,x:1,z:0,run:true,jump:false},'local').reason,'vehicle');
    s.advance(s.tick+240,t=>{if(t%6===1)s.car.receive(drive(t),'local');});
    assert.ok(s.car.snapshot().position[2]>15);assert.ok(s.car.snapshot().speed>5);
    s.advance(s.tick+240);assert.ok(s.car.snapshot().speed<.6);
    assert.equal(s.car.receive(cmd('exit',s.tick,1001),'local').accepted,true);s.advance(s.tick+CAR_GUIDES.exit.duration);
    assert.equal(s.car.snapshot().phase,'parked');assert.equal(s.actor.snapshot().vehicleId,undefined);assert.ok(Math.abs(s.actor.snapshot().y)<.001);
    assert.deepEqual(JSON.parse(JSON.stringify(s.car.snapshot())),s.car.snapshot());
  }finally{s.car.dispose();}
});

test('vehicle intent validates identity, shape, finite ranges, sequences, rate, stale input and TTL',()=>{
  const s=session();try{
    s.advance(120);
    for(const value of [null,{},[],{...cmd('enter',120),extra:true},{...cmd('enter',120),characterId:'npc/1'},{...cmd('enter',120),vehicleId:'other'}])assert.equal(s.car.receive(value,'local').accepted,false);
    assert.equal(s.car.receive(cmd('enter',120),'other').reason,'owner');assert.equal(s.car.receive(cmd('enter',121),'local').reason,'stale');
    assert.equal(s.car.receive(cmd('enter',120),'local').accepted,true);assert.equal(s.car.receive(cmd('enter',120),'local').reason,'sequence');assert.equal(s.car.receive(cmd('enter',120,121),'local').reason,'rate');
    while(s.car.snapshot().phase!=='driving'&&s.tick<650)s.advance(s.tick+1);
    for(const value of [{...drive(s.tick+1),throttle:NaN},{...drive(s.tick+1),steer:2},{...drive(s.tick+1),brake:1},{...drive(s.tick+1),position:[100,0,100]}])assert.equal(s.car.receive(value,'local').accepted,false);
    assert.equal(s.car.receive(drive(s.tick+1),'local').accepted,true);s.advance(s.tick+260);assert.ok(s.car.snapshot().speed<.6,'Lost keepalive must apply brakes');
    assert.throws(()=>s.car.step(s.tick+2,s.actor.snapshot()),/consecutive/);
  }finally{s.car.dispose();}
});

test('Cannon chassis collides with a wall and parked car blocks the walking controller',()=>{
  const wall={id:'wall',minX:-20,maxX:20,minZ:15,maxZ:16,minY:0,maxY:10};const s=session({...world,blockers:[wall]});try{
    board(s);s.advance(s.tick+402,t=>{if(t%6===1)s.car.receive(drive(t),'local');});assert.ok(s.car.snapshot().position[2]<13.3);
  }finally{s.car.dispose();}
  const onFoot=session();try{onFoot.advance(120);onFoot.advance(240,t=>{if(t%6===1)onFoot.actor.receive({type:'move',characterId:'local-player',sequence:t,tick:t-1,x:1,z:0,run:false,jump:false},'local');});assert.ok(onFoot.actor.snapshot().x<2.3);}finally{onFoot.car.dispose();}
});

test('vehicle fixed-step physics matches different render FPS and a retained long pause',()=>{
  const run=(chunks:number[])=>{const s=session(),clock=createLocalAuthority();clock.addSystem(t=>{if(t===120)s.car.receive(cmd('enter',119,120),'local');if(s.car.snapshot().phase==='driving'&&t%6===1)s.car.receive(drive(t),'local');s.advance(t);});try{for(const ms of chunks)clock.advance(ms);while(clock.snapshot().pendingTicks)clock.advance(0);return {car:s.car.snapshot(),actor:s.actor.snapshot()};}finally{s.car.dispose();}};
  const a=run(Array(30*8).fill(1000/30));assert.deepEqual(a,run(Array(144*8).fill(1000/144)));assert.deepEqual(a,run([8000]));
});

test('vehicle delivery reorders/drops real commands and closes pending work',async()=>{
  const authority=createVehicleAuthority(world),character=createCharacterAuthority(world),connection=createVehicleConnection(authority,{latencyTicks:2,jitterTicks:2,dropEvery:4,seed:17});try{
    for(let t=1;t<=120;t++){character.setVehicleFrame(connection.step(t,character.snapshot()));character.step(t);}
    const requests=Array.from({length:8},(_,i)=>connection.send(cmd('enter',120,121+i)));
    for(let t=121;t<=135;t++){character.setVehicleFrame(connection.step(t,character.snapshot()));character.step(t);}
    const results=await Promise.all(requests);assert.ok(results.some(r=>r.accepted));assert.ok(results.some(r=>r.reason==='dropped'));assert.ok(results.some(r=>r.reason==='sequence'||r.reason==='rate'||r.reason==='unavailable'));
    const pending=connection.send(cmd('exit',135,200));connection.close();assert.equal((await pending).reason,'closed');assert.equal((await connection.send(cmd('exit',135,201))).reason,'closed');
  }finally{connection.close();authority.dispose();}
});

test('prepared car keeps its budget, real texture/AO and functional door/wheel pivots',()=>{
  const bytes=readFileSync(new URL('../public/models/car/car.glb',import.meta.url)),manifest=JSON.parse(readFileSync(new URL('../public/models/car/manifest.json',import.meta.url),'utf8'));
  const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());assert.ok(manifest.triangles<4000);assert.equal(manifest.sha256,createHash('sha256').update(bytes).digest('hex'));assert.ok(bytes.length<600000);
  for(const name of ['door/left','door/right'])assert.equal(gltf.nodes.filter((n:{name:string})=>n.name===name).length,1,'Exterior door must be unique: '+name);
  for(const name of ['door/left','door/right','wheel/front/left','wheel/front/right','wheel/rear/left','wheel/rear/right','steering'])assert.ok(gltf.nodes.some((n:{name:string})=>n.name===name),name);
  for(const material of gltf.materials){
    const albedo=material.pbrMetallicRoughness.baseColorTexture;
    assert.ok(albedo);
    assert.equal(gltf.samplers[gltf.textures[albedo.index].sampler].minFilter,9729);
  }
  assert.ok(gltf.materials.some((m:{normalTexture?:unknown})=>m.normalTexture));assert.equal(gltf.textures.length,2);
});


test('all four wheels roll, left/right steering is correct and the higher speed is attainable',()=>{
  const s=session({...world,bounds:{minX:-1000,maxX:1000,minZ:-1000,maxZ:1000}});
  try{board(s);s.advance(s.tick+240,t=>{if(t%6===1)s.car.receive(drive(t),'local');});const before=s.car.snapshot();
    s.advance(s.tick+10,t=>{if(t%6===1)s.car.receive(drive(t),'local');});const after=s.car.snapshot();
    for(let i=0;i<4;i++){const dot=before.wheels[i].rotation.reduce((n,v,j)=>n+v*after.wheels[i].rotation[j],0);assert.ok(Math.abs(dot)<.99,'A rolling wheel was locked by coast braking');}
    s.advance(s.tick+350,t=>{if(t%6===1)s.car.receive(drive(t),'local');});assert.ok(s.car.snapshot().speed>30,'Vehicle failed to exceed 108 km/h');
  }finally{s.car.dispose();}
  for(const steer of [-1,1]){const turn=session();try{board(turn);const start=turn.car.snapshot().position[0];turn.advance(turn.tick+120,t=>{if(t%6===1)turn.car.receive(drive(t,1,steer),'local');});assert.ok((turn.car.snapshot().position[0]-start)*steer<-.5,'Steering direction is reversed');}finally{turn.car.dispose();}}
});


test('automatic boarding uses character collisions, an authored stand point and brief height change',()=>{
  const s=session();try{ s.advance(120);const start={...s.actor.snapshot()};assert.equal(s.car.receive(cmd('enter',120),'local').accepted,true);
    let previous=s.actor.snapshot(),run=false;
    while(s.car.snapshot().phase==='approaching'&&s.tick<600){s.advance(s.tick+1);const a=s.actor.snapshot();assert.ok(Math.hypot(a.x-previous.x,a.z-previous.z)<=7/60+.0001);assert.ok(Math.abs(a.y)<.001);run||=a.running;previous=a;}
    assert.equal(run,false,'Nearby boarding should use walking');assert.equal(s.car.snapshot().phase,'entering');const begin=s.tick,standing=s.actor.snapshot();assert.ok(Math.hypot(standing.x-start.x,standing.z-start.z)>.5);
    assert.ok(Math.abs(standing.x-s.car.snapshot().position[0]-CAR_GUIDES.stand.x)<.1);
    s.advance(begin+CAR_GUIDES.enter.lift[0]-1);assert.ok(s.actor.snapshot().y<.12);
    s.advance(begin+CAR_GUIDES.enter.lift[1]);assert.ok(s.actor.snapshot().y>.2);
    s.advance(begin+CAR_GUIDES.enter.duration);assert.equal(s.car.snapshot().phase,'driving');
    assert.ok(Math.abs(s.actor.snapshot().z-s.car.snapshot().position[2]-CAR_GUIDES.seat.z)<.01,'Boarding ends at the authored driver seat');
  }finally{s.car.dispose();}
  const cancelled=session();try{cancelled.advance(120);cancelled.car.receive(cmd('enter',120),'local');cancelled.advance(125);assert.equal(cancelled.car.receive(cmd('exit',125,200),'local').accepted,true);cancelled.advance(126);assert.equal(cancelled.actor.snapshot().vehicleId,undefined);assert.equal(cancelled.car.snapshot().phase,'parked');const x=cancelled.actor.snapshot().x;assert.equal(cancelled.actor.receive({type:'move',characterId:'local-player',sequence:1,tick:126,x:1,z:0,run:false,jump:false},'local').accepted,true);cancelled.advance(127);assert.ok(cancelled.actor.snapshot().x>x);}finally{cancelled.car.dispose();}
});


test('steering is rate limited and wheel attachments follow tilted chassis coordinates',()=>{
  const s=session();try{board(s);const t=s.tick;s.car.receive(drive(t+1,0,1),'local');s.advance(t+1);
    assert.ok(s.car.snapshot().steering<0);assert.ok(Math.abs(s.car.snapshot().steering)<=2.4/60+1e-9);
    s.advance(t+6);assert.ok(Math.abs(s.car.snapshot().steering)>.1);
    s.car.receive(drive(s.tick+1,0,-1),'local');const before=s.car.snapshot().steering;s.advance(s.tick+1);
    assert.ok(Math.abs(s.car.snapshot().steering-before)<=2.4/60+1e-9);
  }finally{s.car.dispose();}
  const tilted=session({...world,baseHeight:-100,triangles:[[-100,-80,-100,100,80,-100,100,80,100],[-100,-80,-100,100,80,100,-100,-80,100]]});try{tilted.advance(120);const s=tilted.car.snapshot(),q=new Quaternion(...s.rotation),inverse=q.conjugate();
    assert.ok(Math.abs(s.rotation[2])>.1,'Fixture must tilt the chassis');
    for(let i=0;i<4;i++){const p=s.wheels[i].position,local=inverse.vmult(new Vec3(p[0]-s.position[0],p[1]-s.position[1],p[2]-s.position[2]));
      assert.ok(Math.abs(local.x-(i%2===0?-.928:.928))<1e-6);
      assert.ok(Math.abs(local.z-(i<2?1.34:-1.351))<1e-6);
      assert.ok(local.y>.2&&local.y<.8);
    }
  }finally{tilted.car.dispose();}
});


test('exit at speed plays half the moving exit and leaves the driver door open',()=>{
  const s=session();try{board(s);s.advance(s.tick+180,t=>{if(t%6===1)s.car.receive(drive(t),'local');});
    const speed=s.car.snapshot().speed;assert.ok(speed>10);
    assert.equal(s.car.receive(cmd('exit',s.tick,2000),'local').accepted,true);s.advance(s.tick+1);
    assert.equal(s.actor.snapshot().vehicleId,'car/0');assert.equal(s.car.snapshot().phase,'exiting');assert.equal(s.actor.snapshot().vehicleAnimation,'exiting');
    assert.ok(s.car.snapshot().speed>speed*.95);const startZ=s.actor.snapshot().z,begin=s.tick-1;
    s.advance(begin+30);assert.ok(s.car.snapshot().leftDoor>1);assert.ok(s.actor.snapshot().z>startZ+3,'Exit pose did not follow the moving vehicle');
    s.advance(begin+CAR_GUIDES.exit.movingDuration-1);assert.equal(s.actor.snapshot().vehicleAnimation,'exiting');assert.ok(Math.abs(s.actor.snapshot().y)<.001,'Moving exit must reach the ground before release');
    s.advance(begin+CAR_GUIDES.exit.movingDuration);assert.equal(s.actor.snapshot().vehicleId,undefined);assert.equal(s.car.snapshot().phase,'parked');
    assert.ok(Math.abs(s.actor.snapshot().x-s.car.snapshot().position[0])>1.5);assert.ok(Math.abs(s.actor.snapshot().z-s.car.snapshot().position[2]-CAR_GUIDES.stand.z)<.02);
    assert.ok(s.car.snapshot().speed>speed*.8,'Exit unexpectedly stopped the car');
    assert.ok(s.car.snapshot().leftDoor>1.1);s.advance(s.tick+60);assert.ok(s.car.snapshot().leftDoor>1.1,'Moving exit closed the abandoned door');
  }finally{s.car.dispose();}
});


test('boarding paths avoid unnecessary grid detours and shorten corners around obstacles',()=>{
  assert.deepEqual(findPedestrianPath(world,{x:0,z:0},{x:2.3,z:1.7}),[{x:2.3,z:1.7}]);
  const blocker={id:'wall',minX:1,maxX:2,minZ:-1,maxZ:1,minY:0,maxY:3};
  const path=findPedestrianPath({...world,blockers:[blocker]},{x:0,z:0},{x:3,z:0});
  assert.ok(path.length>=2);assert.ok(path.length<=4);let p={x:0,z:0};
  for(const next of path){for(let t=0;t<=1;t+=.01){const x=p.x+(next.x-p.x)*t,z=p.z+(next.z-p.z)*t;assert.ok(!(x>.65&&x<2.35&&z>-1.35&&z<1.35));}p=next;}
});


test('door clears the seated arm early on exit and stays open until boarding finishes',()=>{
  const s=session();try{s.advance(120);s.car.receive(cmd('enter',120),'local');while(s.car.snapshot().phase==='approaching')s.advance(s.tick+1);
    const start=s.tick;s.advance(start+CAR_GUIDES.enter.move[1]);assert.ok(s.car.snapshot().leftDoor>1.1,'Door closed across the arm before the driver reached the seat');
    s.advance(start+CAR_GUIDES.enter.duration);s.car.receive(cmd('exit',s.tick,1000),'local');s.advance(s.tick+12);
    assert.ok(s.car.snapshot().leftDoor>.5,'Door remained closed while the seated arm pushed outward');
    s.advance(s.tick+9);assert.ok(s.car.snapshot().leftDoor>1.1);
  }finally{s.car.dispose();}
});


test('arcade chassis keeps moving over rough terrain and rebounds from a solid wall',()=>{
  const triangles:number[][]=[],height=(z:number)=>z<8?0:.35*(1-Math.cos((z-8)*Math.PI/4));
  for(let z=-20;z<200;z+=2){const a=height(z),b=height(z+2);triangles.push([-100,a,z,100,a,z,100,b,z+2],[-100,a,z,100,b,z+2,-100,b,z+2]);}
  const rough=session({...world,bounds:{...world.bounds,maxZ:200},triangles});try{board(rough);rough.advance(rough.tick+600,t=>{if(t%6===1)rough.car.receive(drive(t),'local');});
    assert.ok(rough.car.snapshot().position[2]>85,'Small terrain crests consumed most forward progress');assert.ok(rough.car.snapshot().speed>8);
  }finally{rough.car.dispose();}
  const wall=session({...world,blockers:[{id:'wall',minX:-50,maxX:50,minZ:22,maxZ:24,minY:0,maxY:20}]});try{board(wall);let previous=wall.car.snapshot().position[2],rebound=0;
    for(let i=0;i<300;i++){wall.advance(wall.tick+1,t=>{if(t%6===1)wall.car.receive(drive(t),'local');});const z=wall.car.snapshot().position[2];rebound=Math.min(rebound,(z-previous)*60);previous=z;}
    assert.ok(rebound<-2.5,'Impact failed to produce a visible rebound');assert.ok(wall.car.snapshot().position[2]<21);
  }finally{wall.car.dispose();}
});


test('vehicle enters a large concave facade recess but collides with its rear wall in either winding',()=>{
  const outline=[[-6,10],[-1,10],[-1,28],[9,28],[9,10],[14,10],[14,35],[-6,35]];
  for(const ring of [outline,[...outline].reverse()]){
    const w={...world,blockers:[{id:'recessed-building',minX:-6,maxX:14,minZ:10,maxZ:35,minY:0,maxY:30,outline:ring}]};
    const s=session(w);try{board(s);let furthest=0;s.advance(s.tick+360,t=>{if(t%6===1)s.car.receive(drive(t),'local');furthest=Math.max(furthest,s.car.snapshot().position[2]);});
      assert.ok(furthest>23,'A bounding box blocked the open facade recess');assert.ok(furthest<27,'The car crossed the solid rear facade');
    }finally{s.car.dispose();}
    const person=createCharacterAuthority({...w,spawn:{x:3.5,z:12}});person.receive({type:'move',characterId:'local-player',sequence:1,tick:0,x:0,z:1,run:true,jump:false},'local');
    for(let t=1;t<=100;t++)person.step(t);assert.ok(person.snapshot().z>12);
    assert.throws(()=>createCharacterAuthority({...w,spawn:{x:-3,z:15}}),/blocked/);
  }
});


test('responsive city steering turns tightly while high-speed steering stays stable',()=>{
  for(const speed of [12,30])for(const steer of [-1,1]){const s=session({...world,bounds:{minX:-1000,maxX:1000,minZ:-1000,maxZ:1000}});try{board(s);
    while(s.car.snapshot().speed<speed&&s.tick<2000)s.advance(s.tick+1,t=>{s.car.receive(drive(t,1,0),'local');});
    s.advance(s.tick+60,t=>{s.car.receive(drive(t,0,steer),'local');});const a=s.car.snapshot(),yaw=2*Math.atan2(a.rotation[1],a.rotation[3]);
    assert.ok(yaw*steer<0);if(speed===12)assert.ok(Math.abs(yaw)>.7,'City-speed turn was too wide');
    else assert.ok(Math.abs(a.steering)<.04,'High-speed steering became too sharp');
    assert.ok(new Quaternion(...a.rotation).vmult(new Vec3(0,1,0)).y>.9,'Steering rolled the chassis');
  }finally{s.car.dispose();}}
});


test('released throttle slows gradually and an abandoned car comes to rest',()=>{
  for(const abandon of [false,true]){const s=session({...world,bounds:{minX:-1000,maxX:1000,minZ:-1000,maxZ:1000}});try{board(s);s.advance(s.tick+180,t=>{if(t%6===1)s.car.receive(drive(t),'local');});
    const initial=s.car.snapshot().speed;assert.ok(initial>10);
    if(abandon)assert.equal(s.car.receive(cmd('exit',s.tick,2000),'local').accepted,true);
    s.advance(s.tick+60,t=>{if(!abandon)s.car.receive(drive(t,0,0),'local');});const coast=s.car.snapshot().speed;
    assert.ok(coast<initial-1,'Releasing throttle did not create rolling resistance');assert.ok(coast>initial*.65,'Coasting stopped too abruptly');
    s.advance(s.tick+1200,t=>{if(!abandon)s.car.receive(drive(t,0,0),'local');});assert.ok(s.car.snapshot().speed<.2,'Car kept coasting without a driver or throttle');
  }finally{s.car.dispose();}}
});


test('a physically overturned car uses a crawling exit then releases ordinary walking',()=>{
  const w={...world,bounds:{minX:-200,maxX:200,minZ:-200,maxZ:200},floors:[{minX:4,maxX:20,minZ:14,maxZ:100,elevation:1}]};
  const s=session(w);try{board(s);while(new Quaternion(...s.car.snapshot().rotation).vmult(new Vec3(0,1,0)).y>-.5&&s.tick<1000)s.advance(s.tick+1,t=>{s.car.receive(drive(t),'local');});
    assert.ok(new Quaternion(...s.car.snapshot().rotation).vmult(new Vec3(0,1,0)).y<-.5,'Fixture did not overturn the car');
    assert.equal(s.car.receive(cmd('exit',s.tick,10000),'local').accepted,true);const start=s.tick;
    s.advance(start+1);assert.equal(s.actor.snapshot().vehicleAnimation,'crawling');assert.equal(s.actor.snapshot().vehicleRotation,undefined);
    s.advance(start+30);assert.equal(s.actor.snapshot().vehicleAnimation,'crawling');assert.ok(Math.max(s.car.snapshot().leftDoor,s.car.snapshot().rightDoor)>1.1);assert.ok(Math.min(s.car.snapshot().leftDoor,s.car.snapshot().rightDoor)<.01);
    s.advance(start+CAR_GUIDES.crawl.duration-1);assert.equal(s.actor.snapshot().vehicleAnimation,'crawling');
    s.advance(start+CAR_GUIDES.crawl.duration);const a=s.actor.snapshot();assert.equal(a.vehicleId,undefined);const car=s.car.snapshot(),offset=new Quaternion(...car.rotation).vmult(new Vec3(0,.65,0));assert.ok(Math.hypot(a.x-car.position[0]-offset.x,a.z-car.position[2]-offset.z)>2.4);
    assert.equal(s.actor.receive({type:'move',characterId:'local-player',sequence:1,tick:s.tick,x:0,z:1,run:false,jump:false},'local').accepted,true);
    assert.ok(new Quaternion(...s.car.snapshot().rotation).vmult(new Vec3(0,1,0)).y<.35);
    assert.equal(s.car.receive(cmd('enter',s.tick,10001),'local').reason,'overturned');assert.equal(s.car.snapshot().phase,'parked');
  }finally{s.car.dispose();}
});

test('vehicle moves inside the real Art Institute courtyard and stops at the inner facade',async()=>{
  const {citySource}=await import('../src/modules/world/city.ts');
  const {cityCollision}=await import('../src/modules/world/headless.ts');
  const s=session({...cityCollision(citySource),spawn:{x:738.5,z:-520}});
  try{
    board(s);
    let furthest=s.car.snapshot().position[2];
    for(let i=0;i<155;i++){
      s.advance(s.tick+1,t=>{if(i%6===0)assert.ok(s.car.receive(drive(t),'local').accepted);});
      furthest=Math.max(furthest,s.car.snapshot().position[2]);
    }
    assert.ok(furthest>-507&&furthest<-502.5,String(furthest));
  }finally{s.car.dispose();}
});

test('a pedestrian occupying the release point prevents exit until it clears',()=>{
  const s=session();
  try {
    board(s);
    s.car.observeCharacter(s.actor.snapshot(),()=>false);
    assert.equal(s.car.receive(cmd('exit',s.tick,1000),'local').reason,'blocked-exit');
    assert.equal(s.car.snapshot().phase,'driving');
    s.car.observeCharacter(s.actor.snapshot());
    assert.ok(s.car.receive(cmd('exit',s.tick,1001),'local').accepted);
  } finally {
    s.car.dispose();
  }
});

test('position reset frees the vehicle seat without moving or recreating the car',()=>{
  const s=session();
  try {
    board(s);
    const before=s.car.snapshot();
    s.car.resetOccupancy();
    assert.deepEqual(s.car.snapshot(),{...before,phase:'parked',driverId:null});
  } finally {s.car.dispose();}
});
