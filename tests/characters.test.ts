import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayHeight } from '../src/modules/characters/height-presentation.ts';
import { createLocalAuthority, STEP_MS } from '../src/simulation/authority.ts';
import { createCharacterAuthority, createCharacterAuthorityFactory, createLocalConnection, type MoveCommand, type Receipt } from '../src/modules/characters/headless.ts';
import { createCollisionWorld, type CollisionWorld } from '../src/modules/world/headless.ts';
import { generateWorldRegions } from '../src/modules/world-generation/headless.ts';
import { scheme,regions,insertions } from '../src/modules/world/scheme.ts';

const world: CollisionWorld = { bounds:{minX:-100,maxX:100,minZ:-100,maxZ:100},baseHeight:0,slopeX:0.015,spawn:{x:0,z:0},
  blockers:[{id:'wall',minX:2,maxX:3,minZ:-5,maxZ:5,minY:-2,maxY:10}],floors:[{minX:-10,maxX:1,minZ:1,maxZ:5,elevation:0.2}] };
const command = (sequence=1,x=0,z=1,run=false): MoveCommand => ({type:'move',characterId:'local-player',sequence,tick:sequence-1,x,z,run,jump:false});

test('display height eases across ground changes in either direction at any frame rate', () => {
  const level={y:1,grounded:true,mode:'walk' as const};
  const raised={...level,y:1.2};
  const smooth=createDisplayHeight(), slow=createDisplayHeight();
  assert.equal(smooth(level,0),1);
  slow(level,0);
  const first=smooth(raised,20);
  assert.ok(first>1 && first<1.2);
  for(let i=0;i<4;i++)smooth(raised,20);
  assert.ok(Math.abs(smooth(raised,0)-slow(raised,100))<1e-9);
  assert.equal(smooth(raised,1000),1.2);
  const down=smooth(level,20);
  assert.ok(down>1 && down<1.2);
  assert.ok(smooth({...raised,vehicleAnimation:'approaching'},20)<1.2);
});

test('display height follows airborne and seated poses directly and resets on discontinuities',()=>{
  const level={y:1,grounded:true,mode:'walk' as const};
  const smooth=createDisplayHeight();
  smooth(level,0);
  assert.equal(smooth({...level,y:1.1,grounded:false},16),1.1);
  assert.equal(smooth({...level,y:1.25},16),1.25);
  assert.equal(smooth({...level,y:1.4,mode:'fly'},16),1.4);
  assert.equal(smooth({...level,y:1.45,mode:'swim'},16),1.45);
  assert.equal(smooth({...level,y:1.5,vehicleAnimation:'entering'},16),1.5);
  assert.equal(smooth(level,16),1);
  assert.equal(smooth({...level,y:2},16),2);
  assert.equal(smooth({...level,y:2.2},16,true),2.2);
  assert.ok(smooth({...level,y:2.5},0)>=2.5-.24);
});

test('local resume uses a valid XYZ and falls back if saved coordinates are unsafe', () => {
  const create = createCharacterAuthorityFactory(world);
  const restored = create(20,undefined,{x:-4,y:5,z:4});
  assert.deepEqual([restored.snapshot().x,restored.snapshot().y,restored.snapshot().z],[-4,5,4]);
  assert.equal(restored.snapshot().grounded,false);
  restored.step(21);
  assert.ok(restored.snapshot().y<5);
  for (const position of [{x:2.5,y:0,z:0},{x:101,y:0,z:0},{x:0,y:-5,z:0},{x:0,y:NaN,z:0}]) {
    const fallback = create(20,undefined,position).snapshot();
    assert.deepEqual([fallback.x,fallback.y,fallback.z],[0,0,0]);
  }
});

test('crouch and crawl use posture speeds and clearance, and prone turns only when moving',()=>{
  const flat={...world,slopeX:0,floors:[],blockers:[{id:'low-ceiling',minX:.6,maxX:3,minZ:-1,maxZ:1,minY:.96,maxY:2.4}]};
  const a=createCharacterAuthority(flat);
  assert.equal(a.receive({...command(),stance:'invalid'},'local').reason,'invalid');
  function move(tick:number,input:Partial<MoveCommand>){
    assert.equal(a.receive({...command(tick,0,0),...input},'local').accepted,true);
    a.step(tick);
  }
  move(1,{stance:'crouching',z:1,run:true});
  assert.equal(a.snapshot().stance,'crouching');
  assert.equal(a.snapshot().z,1.05/60);
  assert.equal(a.snapshot().running,false);
  move(2,{stance:'prone',facing:Math.PI/2,jump:true});
  assert.equal(a.snapshot().stance,'prone');
  assert.equal(a.snapshot().yaw,0);
  assert.equal(a.snapshot().y,0);
  assert.ok(a.snapshot().grounded);
  for(let tick=3;tick<=86;tick++)move(tick,{x:1,facing:-Math.PI/2,run:true,locomotion:{boost:true,lift:0,flight:null}});
  assert.ok(Math.abs(a.snapshot().x-84*.65/60)<1e-9);
  assert.equal(a.snapshot().yaw,Math.PI/2);
  assert.equal(a.snapshot().boosted,false);
  move(87,{stance:'standing',facing:0,locomotion:{boost:false,lift:0,flight:true}});
  assert.equal(a.snapshot().stance,'prone');
  assert.equal(a.snapshot().mode,'walk');
  assert.equal(a.snapshot().yaw,Math.PI/2);
  move(88,{stance:'crouching'});
  assert.equal(a.snapshot().stance,'prone');
  for(let tick=89;tick<=225;tick++)move(tick,{x:-1});
  move(226,{stance:'standing',facing:.4});
  assert.equal(a.snapshot().stance,'standing');
  assert.equal(a.snapshot().yaw,.4);
});

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

test('terrain reuse requires immutable triangle rows and preserves mutable fixture snapshots',()=>{
  const plane=[-1,1,-1,2,1,-1,-1,1,2];
  const collision={...world,baseHeight:-10,slopeX:0,floors:[],triangles:Object.freeze([plane])};
  const original=createCharacterAuthority(collision);
  for(const offset of [1,4,7])plane[offset]=2;
  assert.equal(createCharacterAuthority(collision).snapshot().y,2);
  original.step(1);assert.equal(original.snapshot().y,1);
  const frozen={...collision,triangles:Object.freeze([Object.freeze([...plane])])};
  assert.deepEqual(createCharacterAuthority(frozen).snapshot(),createCharacterAuthority(frozen).snapshot());
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

test('explicit facing rotates idle and strafing actors without movement, and legacy commands restore travel facing',()=>{
  const a=createCharacterAuthority({...world,blockers:[],floors:[]});
  for(const facing of [NaN,Infinity,-Infinity,Math.PI+.01,-Math.PI-.01,'0',undefined,false])assert.equal(a.receive({...command(),facing},'local').reason,'invalid');
  assert.equal(a.receive({...command(),facing:0,extra:true},'local').reason,'invalid');
  assert.equal(a.receive({...command(1,0,0),facing:Math.PI/2},'local').accepted,true);
  assert.equal(a.snapshot().yaw,0,'receive must not change state before a tick');
  a.step(1);assert.equal(a.snapshot().yaw,Math.PI/2);assert.equal(a.snapshot().moving,false);assert.equal(a.snapshot().x,0);assert.equal(a.snapshot().z,0);
  assert.equal(a.receive({...command(2,0,1),facing:-Math.PI/2},'local').accepted,true);
  a.step(2);assert.equal(a.snapshot().yaw,-Math.PI/2);assert.ok(a.snapshot().z>0);
  assert.equal(a.receive({...command(3,0,1),facing:null},'local').accepted,true);
  a.step(3);assert.equal(a.snapshot().yaw,0);
  assert.equal(a.receive(command(4,1,0),'local').accepted,true);
  a.step(4);assert.equal(a.snapshot().yaw,Math.PI/2);
});

test('facing intentions use the existing delayed protocol and reject reordered stale headings',async()=>{
  const a=createCharacterAuthority({...world,blockers:[],floors:[]});
  const connection=createLocalConnection(a,{latencyTicks:2});
  const pending=connection.send({...command(1,0,0),facing:Math.PI});
  assert.equal(a.snapshot().yaw,0);
  connection.step(1);connection.step(2);assert.equal(a.snapshot().yaw,0);
  connection.step(3);assert.equal((await pending).accepted,true);assert.equal(a.snapshot().yaw,Math.PI);
  assert.equal(a.receive({...command(1,0,0),tick:3,facing:0},'local').reason,'sequence');
  for(let tick=4;tick<=20;tick++)connection.step(tick);
  assert.equal(a.snapshot().moving,false);assert.equal(a.snapshot().yaw,Math.PI);
  connection.close();
});

const locomotionWorld:CollisionWorld={...world,baseHeight:0,slopeX:0,blockers:[],floors:[]};
const createInput=(tick:number,changes:Partial<MoveCommand>={}):MoveCommand=>({...command(tick,0,0),...changes});
function locomotionStep(a:ReturnType<typeof createCharacterAuthority>,changes:Partial<MoveCommand>,count:number){
  for(let i=0;i<count;i++){
    const next=a.snapshot().tick+1;
    if(i%6===0)assert.equal(a.receive(createInput(next,changes),'local').accepted,true);
    a.step(next);
  }
  return a.snapshot();
}

test('boost runs at 22 m/s and still cannot tunnel through a narrow barrier',()=>{
  const travel=(boost:boolean,blockers:CollisionWorld['blockers']=[])=>{
    const a=createCharacterAuthority({...locomotionWorld,blockers});
    return locomotionStep(a,{z:1,run:true,locomotion:{boost,lift:0,flight:null}},60);
  };
  assert.ok(Math.abs(travel(false).z-7)<1e-8);
  assert.ok(Math.abs(travel(true).z-22)<1e-8);
  assert.equal(travel(true).boosted,true);
  const stopped=travel(true,[{id:'pole',minX:-.05,maxX:.05,minZ:5,maxZ:5.02,minY:0,maxY:3}]);
  assert.ok(stopped.z>4.5&&stopped.z<=4.65);
});

test('flight is deterministic at different render rates, boosts, brakes and lands on a roof',()=>{
  const setup={...locomotionWorld,blockers:[{id:'roof',minX:-5,maxX:5,minZ:34,maxZ:45,minY:0,maxY:9}]};
  function run(fps:number){
    const a=createCharacterAuthority(setup),clock=createLocalAuthority();
    clock.addSystem(tick=>{
      if(tick%6===1)a.receive(createInput(tick,{z:Number(tick>36),locomotion:{boost:tick>36,lift:tick<=36?1:0,flight:tick===1?true:null}}),'local');
      a.step(tick);
    });
    for(let frame=0;frame<fps*2;frame++)clock.advance(1000/fps);
    return a.snapshot();
  }
  const flying=run(60);
  assert.deepEqual(flying,run(30));assert.deepEqual(flying,run(144));
  assert.ok(flying.z>50&&flying.y>9&&flying.boosted);

  const a=createCharacterAuthority(setup);
  locomotionStep(a,{locomotion:{boost:false,lift:1,flight:true}},45);
  locomotionStep(a,{z:1,locomotion:{boost:false,lift:0,flight:null}},100);
  const stopped=locomotionStep(a,{locomotion:{boost:false,lift:0,flight:null}},25);
  assert.ok(stopped.z>34&&stopped.z<45,JSON.stringify(stopped));
  assert.equal(stopped.moving,false);
  const landed=locomotionStep(a,{locomotion:{boost:false,lift:-1,flight:null}},100);
  assert.equal(landed.mode,'walk');assert.equal(landed.grounded,true);assert.equal(landed.y,9);

  const blocked=createCharacterAuthority({...locomotionWorld,blockers:[{id:'thin',minX:-2,maxX:2,minZ:37,maxZ:37.02,minY:0,maxY:80}]});
  const hit=locomotionStep(blocked,{z:1,locomotion:{boost:true,lift:0,flight:true}},120);
  assert.ok(hit.z>36&&hit.z<=36.65);
});

const patch=(a:number,b:number,y:number):readonly (readonly number[])[]=>[
  [a,y,-10,b,y,-10,b,y,10], [a,y,-10,b,y,10,a,y,10],
];

test('water entry is automatic, swimmers pass under a bridge, can dive, surface and take flight',()=>{
  const a=createCharacterAuthority({...locomotionWorld,baseHeight:-10,spawn:{x:-1,z:0},
    triangles:[...patch(-10,0,0),...patch(3,5,0)],
    water:{level:-1,triangles:patch(0,20,-1)}});
  const swim=locomotionStep(a,{x:1,run:true},110);
  assert.equal(swim.mode,'swim');assert.equal(swim.grounded,false);
  assert.ok(swim.x>4&&swim.y<=-2.08,JSON.stringify(swim));
  const dive=locomotionStep(a,{x:1,locomotion:{boost:false,lift:-1,flight:null}},60);
  assert.ok(dive.y<swim.y-1);
  const surfaced=locomotionStep(a,{locomotion:{boost:false,lift:1,flight:null}},180);
  assert.ok(Math.abs(surfaced.y+2.08)<1e-6);
  const fly=locomotionStep(a,{locomotion:{boost:false,lift:1,flight:true}},45);
  assert.equal(fly.mode,'fly');assert.ok(fly.y>0&&fly.verticalSpeed>0);
  const cancelled=locomotionStep(a,{locomotion:{boost:false,lift:0,flight:false}},100);
  assert.equal(cancelled.mode,'swim');
});

test('cancelling flight under an elevated deck falls into the river instead of snapping onto the bridge',()=>{
  const a=createCharacterAuthority({...locomotionWorld,baseHeight:-10,spawn:{x:-1,z:0},
    triangles:[...patch(-10,0,0),...patch(2,8,5)],
    water:{level:-1,triangles:patch(0,20,-1)}});
  const swim=locomotionStep(a,{x:1,run:true},110);
  assert.ok(swim.x>2&&swim.x<8&&swim.mode==='swim');
  const underDeck=locomotionStep(a,{locomotion:{boost:false,lift:1,flight:true}},38);
  assert.ok(underDeck.y>0&&underDeck.y<3.3,JSON.stringify(underDeck));
  const fallen=locomotionStep(a,{locomotion:{boost:false,lift:0,flight:false}},90);
  assert.equal(fallen.mode,'swim');
  assert.ok(fallen.y<-2);
});

test('locomotion rejects malformed values and never repeats a flight request as a toggle',()=>{
  const a=createCharacterAuthority(locomotionWorld);
  for(const bad of [null,{}, {boost:1,lift:0,flight:null},{boost:true,lift:Infinity,flight:null},{boost:true,lift:0,flight:'fly'},{boost:true,lift:0,flight:true,extra:1}]){
    assert.equal(a.receive({...command(),locomotion:bad},'local').reason,'invalid');
  }
  assert.equal(locomotionStep(a,{locomotion:{boost:false,lift:1,flight:true}},24).mode,'fly');
});

test('fractional vertical intent follows a flight vector without increasing its total speed',()=>{
  const a=createCharacterAuthority(locomotionWorld);
  const climb=locomotionStep(a,{z:.8,locomotion:{boost:false,lift:.6,flight:true}},90);
  const later=locomotionStep(a,{z:.8,locomotion:{boost:false,lift:.6,flight:null}},60);
  assert.ok(Math.abs(later.z-climb.z-20)<1e-8);
  assert.ok(Math.abs(later.y-climb.y-15)<1e-8);
  const invalid=createInput(later.tick+1,{locomotion:{boost:false,lift:1.01,flight:null}});
  assert.equal(a.receive(invalid,'local').reason,'invalid');
  const descend=locomotionStep(a,{z:.8,locomotion:{boost:false,lift:-.6,flight:null}},60);
  assert.ok(descend.y<later.y-10&&descend.z>later.z);
});


test('local position reset restores spawn, clears queued input and keeps authority tick and identity',async()=>{
  const actor=createCharacterAuthorityFactory(world)(20,undefined,{x:-4,y:5,z:4});
  const connection=createLocalConnection(actor,{latencyTicks:3});
  assert.ok(actor.receive({...command(),tick:20},'local').accepted);
  connection.step(21);
  const queued=connection.send({...command(2),tick:21});
  connection.resetPosition();
  assert.equal((await queued).reason,'reset');
  const initial=createCharacterAuthority(world,21).snapshot();
  assert.deepEqual(actor.snapshot(),{...initial,lastSequence:1});
  for(let tick=22;tick<=26;tick++)connection.step(tick);
  assert.equal(actor.snapshot().z,initial.z);
  assert.ok(actor.receive({...command(2,-1,0),tick:26},'local').accepted);
});
