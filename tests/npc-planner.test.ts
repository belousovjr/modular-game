import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createNpcNavigation, NPC_RADIUS, TRAFFIC_RADIUS } from '../src/modules/npcs/headless.ts';
import { displayNpcPose, npcLodCoverage, NPC_LOD_MARGIN } from '../src/modules/npcs/presentation.ts';
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
