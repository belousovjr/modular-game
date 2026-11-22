import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createCharacterAuthority } from '../src/modules/characters/headless.ts';
import {createLocalAuthority} from '../src/simulation/authority.ts';
import { createNpcNavigation, createTrafficActors, NPC_RADIUS, TRAFFIC_RADIUS, type TrafficRecovery } from '../src/modules/npcs/headless.ts';
import { createNpcPoseHandoff, displayNpcPose, npcLodCoverage, NPC_LOD_MARGIN } from '../src/modules/npcs/presentation.ts';
import { plannerPackets } from '../src/modules/npcs/planner-input.ts';
import { plannerQueryDue, type PlannerRequest, type PlannerResponse } from '../src/modules/npcs/planner-protocol.ts';
import type { CitySource } from '../src/modules/world-generation/headless.ts';
import type { CollisionWorld } from '../src/modules/world/headless.ts';

const bounds={minX:-110,maxX:110,minZ:-110,maxZ:110};
const spawn={x:0,z:0};
const mesh={surface:'sidewalk',positions:[-110,0,-110,110,0,-110,110,0,110,-110,0,110],indices:[0,1,2,0,2,3]};
const city:CitySource={id:'worker-fixture',version:1,bounds,spawn,waterLevel:-4,roads:[],placements:[],colliders:[],
  chunks:[{id:'parcel',bounds,buildingIds:[],meshes:[mesh,{...mesh,surface:'building'}]}]};
const world:CollisionWorld={bounds,spawn,baseHeight:0,slopeX:0,blockers:[],floors:[]};

test('planner packs geometry incrementally and skips surfaces irrelevant to routes',()=>{
  const cityWithManyMeshes={...city,chunks:[{...city.chunks[0],meshes:
    Array.from({length:300},(_,i)=>({...mesh,surface:i%2?'sidewalk':'building'}))}]};
  const batches=[...plannerPackets(cityWithManyMeshes,world,()=>[])];
  assert.ok(batches.length>1&&batches.every(batch=>batch.length<=128));
  assert.equal(batches.flat().length,150);
  assert.ok(batches.flat().every(packet=>packet.kind==='surface'&&packet.meshes[0].surface==='sidewalk'));
});

test('worker starts at the requested tick, sends nearby route deltas and releases subscriptions after moving',{timeout:20_000},async()=>{
  const entry=new URL('../src/modules/npcs/planner.worker.ts',import.meta.url);
  const worker=new Worker(`
    const {parentPort}=require('node:worker_threads');
    globalThis.self={postMessage:message=>parentPort.postMessage(message)};
    import(${JSON.stringify(entry.href)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));
  `,{eval:true});
  try {
    const send=(request:PlannerRequest)=>worker.postMessage(request);
    async function ask(tick:number,x=0) {
      const response=once(worker,'message');
      send({type:'query',query:{tick,origin:{x,z:0}}});
      const [frame]:[PlannerResponse]=await response as [PlannerResponse];
      assert.equal(frame.type,'frame',frame.type==='error'?frame.error:undefined);
      return frame;
    }
    send({type:'init',map:{id:city.id,version:city.version,bounds},spawn});
    for (const batch of plannerPackets(city,world,()=>[])) send({type:'data',batch});
    const handshake=once(worker,'message');
    send({type:'prepare'});
    assert.deepEqual(await handshake,[{type:'ready'}]);
    const now=60_000_000;
    let frame=await ask(now);
    assert.equal(frame.tick,now);
    const received=new Map<string,typeof frame.added[number]>();
    for (let i=0;i<100;i++) {
      assert.ok(frame.added.length<=3);
      for (const id of frame.removed) received.delete(id);
      for (const plan of frame.added) received.set(plan.id,plan);
      if (received.size) break;
      frame=await ask(now);
    }
    assert.ok(received.size);
    assert.ok(frame.population>0);
    const version=createNpcNavigation(city,world,[]).version;
    for (const plan of received.values()) {
      const seed=plan.kind==='resident'?plan.plan.seed:plan.plan.group.recipe;
      assert.equal(seed.navigation,version);
      assert.equal(seed.startTick,now);
    }
    const away=await ask(now,5000);
    assert.deepEqual(away.added,[]);
    assert.deepEqual(new Set(away.removed),new Set(received.keys()));
    assert.deepEqual((await ask(now,5000)).removed,[]);
  } finally {
    await worker.terminate();
  }
});


test('ready NPCs advance with game ticks and hold their reserved endpoint until they receive a new cycle',()=>{
  const a=[0,0,0] as const,b=[12,0,0] as const;
  for (const mode of ['walk','drive'] as const) {
    const cycle={legs:[{a,b,from:0,until:120,mode,distance:0,length:12,yaw:Math.PI/2,pitch:0,into:0,out:0}],
      reservations:[],endTick:120,endAnchor:'end',heading:Math.PI/2};
    assert.deepEqual(displayNpcPose(cycle,60)?.point,[6,0,0]);
    assert.deepEqual(displayNpcPose(cycle,90)?.point,[9,0,0]);
    const waiting=displayNpcPose(cycle,180)!;
    assert.deepEqual(waiting.point,b);
    assert.equal(waiting.speed,0);
    assert.equal(waiting.mode,mode==='drive'?'drive':'idle');
    assert.deepEqual(displayNpcPose(cycle,180,0,1)?.point,[6,0,0]);
  }
});

test('clock polling skips intermediate ticks and still fetches moved or pending plans',()=>{
  const previous={origin:{x:0,z:0},tick:60};
  assert.equal(plannerQueryDue(previous,{...previous,tick:65},false),false);
  assert.equal(plannerQueryDue(previous,{...previous,tick:66},false),true);
  assert.equal(plannerQueryDue(previous,{...previous,tick:61,origin:{x:4,z:0}},false),true);
  assert.equal(plannerQueryDue(previous,previous,true),true);
});

test('people and cars ease in and out and fade before their outer distance cutoff',()=>{
  for (const [car,radius] of [[false,NPC_RADIUS],[true,TRAFFIC_RADIUS]] as const) {
    assert.equal(npcLodCoverage(0,0,car),0);
    assert.equal(npcLodCoverage(.25,0,car),.15625);
    assert.equal(npcLodCoverage(.5,0,car),.5);
    assert.equal(npcLodCoverage(1,0,car),1);
    assert.ok(npcLodCoverage(1,radius,car)>npcLodCoverage(1,radius+4,car));
    assert.equal(npcLodCoverage(1,radius+NPC_LOD_MARGIN,car),0);
  }
});

test('NPC yields to a hero on the route, remains solid, then continues from its held pose',()=>{
  const a=[0,0,0] as const,b=[8,0,0] as const;
  const cycle={legs:[{a,b,from:0,until:240,mode:'walk' as const,distance:0,length:8,yaw:Math.PI/2,pitch:0,into:0,out:0}],
    reservations:[],endTick:240,endAnchor:'end',heading:Math.PI/2};
  const actor={id:'npc/test',cycle};
  const jobs:TrafficRecovery[]=[];
  const traffic=createTrafficActors(job=>jobs.push(job));
  const character=createCharacterAuthority(world);
  try{
    traffic.replace([actor]);
    const hero={...character.snapshot(),x:2,z:0};
    for(let tick=1;tick<=90;tick++)character.setTrafficBlockers(traffic.step(tick,hero));
    const held=traffic.pose(actor,90)!;
    assert.equal(held.mode,'idle');
    assert.ok(held.point[0]>=1 && held.point[0]<1.25);
    assert.equal(jobs.length,1);
    assert.deepEqual(jobs[0].origin,held.point);
    for(let tick=91;tick<=97;tick++)traffic.step(tick,{...hero,z:3});
    const resumed=traffic.pose(actor,97)!;
    assert.equal(resumed.mode,'walk');
    assert.ok(resumed.point[0]>held.point[0] && resumed.point[0]<held.point[0]+.3);
  }finally{character.dispose();}
});

test('traffic recovery checks a pedestrian bypass against a planned surface and the hero',()=>{
  const nav=createNpcNavigation(city,world,[]);
  const target={point:[2.2,0,0],tick:150,yaw:Math.PI/2} as const;
  const recovery=nav.recovery({id:'npc/test',token:1,origin:[-2,0,0],yaw:Math.PI/2,points:[target],avoid:[0,0,0]});
  assert.deepEqual(recovery?.point,target.point);
  assert.ok(recovery?.via && Math.abs(recovery.via[2])>1);
  const carJob={id:'npc/car',token:1,origin:[-2,0,0] as const,yaw:Math.PI/2,points:[target]};
  assert.equal(nav.recovery(carJob),null);
  const asphalt={...city,chunks:[{...city.chunks[0],meshes:[{...mesh,surface:'road'}]}]};
  assert.deepEqual(createNpcNavigation(asphalt,world,[]).recovery(carJob),target);
});

test('walking hero is blocked by a stationary NPC at different render rates and after a long frame',()=>{
  const point=[2,0,0] as const;
  const cycle={legs:[{a:point,b:point,from:0,until:240,mode:'idle' as const,distance:0,length:0,yaw:0,pitch:0,into:0,out:0}],
    reservations:[],endTick:240,endAnchor:'end',heading:0};
  function simulate(deltas:number[]){
    const character=createCharacterAuthority(world);
    const traffic=createTrafficActors(()=>{});
    const clock=createLocalAuthority();
    traffic.replace([{id:'npc/blocker',cycle}]);
    clock.addSystem(tick=>{
      if(tick%6===1)character.receive({type:'move',characterId:'local-player',sequence:tick,tick:tick-1,x:1,z:0,run:false,jump:false},'local');
      character.setTrafficBlockers(traffic.step(tick,character.snapshot()));
      character.step(tick);
    });
    try{
      for(const delta of deltas)clock.advance(delta);
      while(clock.snapshot().pendingTicks)clock.advance(0);
      return character.snapshot();
    }finally{character.dispose();}
  }
  const played=simulate(Array(60).fill(1000/30));
  assert.ok(played.x>1.2 && played.x<1.36);
  assert.deepEqual(played,simulate(Array(288).fill(1000/144)));
  assert.deepEqual(played,simulate([2000]));
});

test('a settled NPC car waits at the crash site and rejoins without a positional snap',()=>{
  const a=[0,0,0] as const,b=[0,0,30] as const;
  const actor={id:'npc/car',cycle:{
    legs:[{a,b,from:0,until:300,mode:'drive' as const,distance:0,length:30,yaw:0,pitch:0,into:0,out:0}],
    reservations:[],endTick:300,endAnchor:'end',heading:0,
  }};
  const character=createCharacterAuthority(world);
  const hero={...character.snapshot(),x:-20,z:-20};
  const jobs:TrafficRecovery[]=[];
  const traffic=createTrafficActors(job=>jobs.push(job));
  try{
    traffic.replace([actor]);
    traffic.step(60,hero);
    const crash=[.6,0,6.4] as const;
    traffic.contacts([{id:actor.id,point:crash,rotation:[0,0,0,1],settled:true}]);
    assert.deepEqual(traffic.pose(actor,60)?.point,crash);
    assert.deepEqual(jobs[0]?.origin,crash);
    const token=jobs[0].token;
    traffic.rejoin(actor.id,token-1,{point:[30,0,30],yaw:0,tick:200});
    traffic.step(61,hero);
    assert.deepEqual(traffic.pose(actor,61)?.point,crash);
    traffic.rejoin(actor.id,token,{point:[0,0,10],yaw:0,tick:100});
    traffic.step(62,hero);
    assert.deepEqual(traffic.pose(actor,62)?.point,crash);
    for(let tick=63;tick<=162;tick++)traffic.step(tick,hero);
    const resumed=traffic.pose(actor,162)!;
    assert.ok(resumed.point[2]>10 && resumed.point[0]===0);
  }finally{character.dispose();}
});

test('NPC contact handoff starts from the last rendered pose and catches up to the moving target', () => {
  const handoff = createNpcPoseHandoff();
  const pose = (x: number) => ({
    point: [x, 0, 0] as const, yaw: 0, pitch: 0, mode: 'drive' as const,
    speed: 0, distance: 0, wheelDistance: 0, steering: 0, door: undefined, doorOpen: 0,
  });
  assert.equal(handoff.sample('car', pose(0), false, 16).point[0], 0);
  assert.equal(handoff.sample('car', pose(1), true, 16).point[0], 0);
  assert.equal(handoff.sample('car', pose(1.2), true, 60).point[0], .6);
  assert.equal(handoff.sample('car', pose(1.4), true, 60).point[0], 1.4);
  assert.equal(handoff.sample('car', pose(1.8), false, 16).point[0], 1.4);
  assert.equal(handoff.sample('other', pose(2), true, 16).point[0], 2);
  assert.equal(handoff.sample('other', pose(10), false, 16).point[0], 10);
});
