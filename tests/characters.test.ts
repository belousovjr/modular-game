import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAuthority, STEP_MS } from '../src/simulation/authority.ts';
import { createCharacterAuthority, createLocalConnection, type MoveCommand, type Receipt } from '../src/modules/characters/headless.ts';
import { createCollisionWorld, type CollisionWorld } from '../src/modules/world/headless.ts';
import { generateWorldRegions } from '../src/modules/world-generation/headless.ts';
import { scheme,regions,insertions } from '../src/modules/world/scheme.ts';

const world: CollisionWorld = { bounds:{minX:-100,maxX:100,minZ:-100,maxZ:100},baseHeight:0,slopeX:0.015,spawn:{x:0,z:0},
  blockers:[{id:'wall',minX:2,maxX:3,minZ:-5,maxZ:5,minY:-2,maxY:10}],floors:[{minX:-10,maxX:1,minZ:1,maxZ:5,elevation:0.2}] };
const command = (sequence=1,x=0,z=1,run=false): MoveCommand => ({type:'move',characterId:'local-player',sequence,tick:sequence-1,x,z,run,jump:false});

test('character ticks and clocks produce the same collision result at different render FPS and retain long-break debt', () => {
  function run(fps: number, pause=false) {
    const clock=createLocalAuthority(), a=createCharacterAuthority(world);
    clock.addSystem(tick=>{ if(tick%6===1) a.receive(command(tick,1,1,true),'local'); a.step(tick); });
    if (pause) { clock.advance(600*STEP_MS); while(clock.snapshot().pendingTicks) clock.advance(0); }
    else for(let frame=0;frame<fps*10;frame++) clock.advance(1000/fps);
    return a.snapshot();
  }
  assert.deepEqual(run(30),run(144)); assert.deepEqual(run(60),run(30,true));
  const s=run(60); assert.ok(s.z>5 && s.x>3); assert.ok(Number.isFinite(s.y));
});

test('authority stops at walls, slides, climbs curbs and slopes, prevents diagonal speed boosts and expires stale input', () => {
  const a=createCharacterAuthority(world);
  a.receive(command(1,1,0,true),'local');
  for(let tick=1;tick<=30;tick++){if(tick%6===1)a.receive(command(tick,1,0,true),'local');a.step(tick);}
  assert.ok(a.snapshot().x<=1.65+1e-9);
  const b=createCharacterAuthority({...world,blockers:[]});
  b.receive(command(1,1,1),'local');
  for(let tick=1;tick<=12;tick++)b.step(tick);
  const s=b.snapshot(); assert.ok(Math.hypot(s.x,s.z)<=1.8*12/60+1e-9);
  b.step(13); assert.equal(b.snapshot().moving,false);
  for(let tick=14;tick<=50;tick++){if(tick%6===1)b.receive(command(tick,0,1),'local');b.step(tick);}
  assert.ok(Math.abs(b.snapshot().y-(b.snapshot().x*.015+.2))<1e-9);
  const cliff=createCharacterAuthority({...world,blockers:[],floors:[{minX:1,maxX:5,minZ:-10,maxZ:10,elevation:1}]});
  for(let tick=1;tick<=60;tick++){if(tick%6===1)cliff.receive(command(tick,1,0),'local');cliff.step(tick);}
  assert.ok(cliff.snapshot().x<1);
});

test('commands validate shape, finite values, ownership, rate and sequences and snapshots cannot mutate authority', () => {
  const a=createCharacterAuthority(world);
  for(const input of [null,{},[],{...command(),x:NaN},{...command(),x:Infinity},{...command(),z:2},{...command(),sequence:0},{...command(),sequence:Number.MAX_SAFE_INTEGER+1},{...command(),run:1},{...command(),extra:1}])assert.equal(a.receive(input,'local').accepted,false);
  assert.equal(a.receive(command(),'other').reason,'owner');
  assert.equal(a.receive(command(),'local').accepted,true);
  assert.equal(a.receive(command(),'local').reason,'sequence');
  assert.equal(a.receive({...command(2),tick:0},'local').reason,'rate');
  const s=a.snapshot();assert.ok(Object.isFrozen(s));assert.deepEqual(JSON.parse(JSON.stringify(s)),s);
  assert.throws(()=>a.step(3));
  a.step(1); assert.equal(a.receive({...command(2),tick:2},'local').reason,'stale');
  assert.throws(()=>createCharacterAuthority({...world,spawn:{x:2.5,z:0}}),/spawn/);
  const clock=createLocalAuthority();const ticks:number[]=[];const remove=clock.addSystem(t=>ticks.push(t));clock.advance(STEP_MS*2);remove();clock.advance(STEP_MS);assert.deepEqual(ticks,[1,2]);
});

test('tick-based delivery handles latency, jitter, loss and reordered old commands, then recovers without retaining pending promises', async () => {
  const a=createCharacterAuthority({...world,blockers:[]});
  const connection=createLocalConnection(a,{latencyTicks:10,jitterTicks:10,dropEvery:3,seed:42});
  const receipts: Promise<Receipt>[]=[];
  for(let tick=1;tick<=120;tick++) {
    if(tick%6===1)receipts.push(connection.send(command(tick,0,tick<60?1:0)));
    connection.step(tick);
  }
  const s=connection.snapshot();assert.equal(s.moving,false);assert.ok(s.z>0&&s.z<4);assert.ok(s.lastSequence>60);
  receipts.push(connection.send(command(121)));
  const pending=connection.send(command(122));connection.close();assert.deepEqual(await pending,{accepted:false,reason:'closed'});
  const results = await Promise.all(receipts);
  assert.ok(results.some(r=>r.reason==='sequence'),'Jitter must exercise reordering');
  assert.equal((await connection.send(command(123))).reason,'closed');
  assert.equal(a.receive(command(1),'local').reason,'sequence');
});

test('world collision data is independent of render LOD and preserves blockers at all region boundaries', () => {
  const placements=[...generateWorldRegions(scheme,regions).flatMap(r=>r.objects),...insertions];
  const collision=createCollisionWorld(placements,scheme.bounds,scheme.baseHeight,scheme.slopeX);
  assert.ok(collision.blockers.length>3000);assert.equal(new Set(collision.blockers.map(b=>b.id)).size,collision.blockers.length);
  const a=createCharacterAuthority(collision);assert.equal(a.snapshot().x,collision.spawn.x);assert.equal(a.snapshot().z,collision.spawn.z);
  assert.ok(Math.abs(a.snapshot().y-(scheme.baseHeight+scheme.slopeX*collision.spawn.x))<1e-9);
});

test('collisions remain solid on spatial-cell boundaries and stale commands cannot restart movement', () => {
  const a=createCharacterAuthority({...world,spawn:{x:31,z:0},floors:[],blockers:[{id:'boundary',minX:32,maxX:33,minZ:-5,maxZ:5,minY:-2,maxY:10}]});
  for(let tick=1;tick<=120;tick++){if(tick%6===1)a.receive(command(tick,1,0,true),'local');a.step(tick);}
  assert.ok(a.snapshot().x<=31.65+1e-9);
  assert.equal(a.receive({...command(121),tick:0},'local').reason,'stale');
  assert.equal(a.receive({...command(121),tick:121},'local').reason,'stale');
});


test('fresh input recovers after a long loss burst without trusting old observed ticks', () => {
  const a=createCharacterAuthority({...world,blockers:[]});
  a.receive(command(),'local');
  for(let tick=1;tick<=200;tick++)a.step(tick);
  assert.equal(a.snapshot().moving,false);
  assert.equal(a.receive({...command(300),tick:200},'local').accepted,true);
  a.step(201);assert.equal(a.snapshot().moving,true);
});


test('jump uses authority gravity, lands, hits ceilings and is identical across render rates', () => {
  const flat={...world,slopeX:0,blockers:[],floors:[]};
  function run(fps:number) {
    const a=createCharacterAuthority(flat),clock=createLocalAuthority();let peak=0;
    clock.addSystem(t=>{if(t%6===1)a.receive({...command(t,1,0),jump:t===1},'local');a.step(t);peak=Math.max(peak,a.snapshot().y);});
    for(let i=0;i<fps*2;i++)clock.advance(1000/fps);
    assert.ok(peak>.8 && peak<1);assert.equal(a.snapshot().grounded,true);assert.equal(a.snapshot().y,0);
    return a.snapshot();
  }
  assert.deepEqual(run(30),run(144));
  const ceiling=createCharacterAuthority({...flat,blockers:[{id:'ceiling',minX:-2,maxX:2,minZ:-2,maxZ:2,minY:2,maxY:3}]});
  ceiling.receive({...command(1,0,0),jump:true},'local');let max=0;
  for(let t=1;t<=90;t++){ceiling.step(t);max=Math.max(max,ceiling.snapshot().y);}
  assert.ok(max<=.2+1e-9);assert.equal(ceiling.snapshot().grounded,true);
  assert.equal(ceiling.receive({...command(100),tick:90,jump:1},'local').reason,'invalid');
});


test('walk and run use distinct authoritative speeds', () => {
  for(const run of [false,true]) {
    const a=createCharacterAuthority({...world,blockers:[],floors:[]});
    for(let t=1;t<=60;t++){if(t%6===1)a.receive(command(t,0,1,run),'local');a.step(t);}
    assert.ok(Math.abs(a.snapshot().z-(run?7:1.8))<1e-8);
  }
});
