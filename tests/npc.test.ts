import {interpolateNpcPosition} from '../src/modules/npc/presentation.ts';
import {createCharacterAuthorityFactory,createLocalConnection} from '../src/modules/characters/headless.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNpcAuthority,downtownPatrols,type Patrol} from '../src/modules/npc/headless.ts';
import {createLocalAuthority,STEP_MS} from '../src/simulation/authority.ts';
import {cityCollision,type CollisionWorld} from '../src/modules/world/headless.ts';
import {citySource} from '../src/modules/world/city.ts';

const world:CollisionWorld={bounds:{minX:-12,maxX:12,minZ:-12,maxZ:12},baseHeight:0,slopeX:0,spawn:{x:-6,z:0},floors:[],blockers:[{id:'wall',minX:-1,maxX:1,minZ:-3,maxZ:3,minY:0,maxY:4}]};
const patrol:Patrol={id:'around-wall',bounds:{minX:-8,maxX:8,minZ:-8,maxZ:8},points:[[-6,0],[6,0]]};

test('NPC plans around a static wall and uses real character collision without teleporting',()=>{
  const npc=createNpcAuthority(world,[patrol],1);
  let previous=npc.snapshot().actors[0],detour=0;
  for(let tick=1;tick<=2400;tick++){
    npc.step(tick);const s=npc.snapshot().actors[0];
    assert.ok(Math.hypot(s.x-previous.x,s.z-previous.z)<=1.8/60+.00001);
    assert.ok(s.x<=-1.35||s.x>=1.35||s.z<=-3.35||s.z>=3.35);
    assert.equal(s.grounded,true);detour=Math.max(detour,Math.abs(s.z));previous=s;
  }
  assert.ok(detour>3.9);assert.ok(npc.snapshot().arrivals>=2);
  assert.equal(previous.id,'npc/0');assert.equal(previous.ownerId,'npc');
  assert.deepEqual(JSON.parse(JSON.stringify(npc.snapshot())),npc.snapshot());
});

test('NPC ticks, patrol budgets, blocked/unreachable points and spawn capacity are validated',()=>{
  assert.throws(()=>createNpcAuthority(world,[patrol],33),/population/);
  assert.throws(()=>createNpcAuthority(world,[patrol],3),/capacity/);
  assert.throws(()=>createNpcAuthority(world,[{...patrol,points:[[0,0],[6,0]]}],1),/Blocked/);
  assert.throws(()=>createNpcAuthority(world,[{...patrol,points:[[NaN,0],[6,0]]}],1),/waypoint/);
  assert.throws(()=>createNpcAuthority(world,[{...patrol,points:[[-6,0],[-6,0]]}],1),/Duplicate/);
  const divided={...world,blockers:[{...world.blockers[0],minZ:-12,maxZ:12}]};
  assert.throws(()=>createNpcAuthority(divided,[patrol],1),/Unreachable/);
  const npc=createNpcAuthority(world,[patrol],1);assert.throws(()=>npc.step(2),/consecutive/);
});

test('NPC results match at different render FPS and after a long retained clock debt',()=>{
  const run=(chunks:number[])=>{
    const npc=createNpcAuthority(world,[patrol],2),clock=createLocalAuthority();clock.addSystem(npc.step);
    for(const ms of chunks)clock.advance(ms);
    while(clock.snapshot().pendingTicks)clock.advance(0);
    return npc.snapshot();
  };
  const a=run(Array(30*20).fill(1000/30)),b=run(Array(144*20).fill(1000/144));
  assert.deepEqual(a,b);assert.deepEqual(a,run([20000]));assert.equal(a.tick,1200);
  const clock=createLocalAuthority(),npc=createNpcAuthority(world,[patrol],1);clock.addSystem(npc.step);clock.advance(10000);
  assert.equal(npc.snapshot().tick,240);assert.equal(clock.snapshot().pendingTicks,600-240);clock.advance(STEP_MS);
  assert.equal(npc.snapshot().tick,480);
});

test('pinned Chicago pedestrian routes stay dry, progress and retain unique authority IDs',()=>{
  const city=cityCollision(citySource),npc=createNpcAuthority(city,downtownPatrols,16);
  for(let tick=1;tick<=3600;tick++){
    npc.step(tick);
    if(tick%60===0)for(const actor of npc.snapshot().actors){assert.ok(actor.y>citySource.waterLevel+1);assert.equal(actor.grounded,true);}
  }
  const s=npc.snapshot();assert.equal(new Set(s.actors.map(a=>a.id)).size,16);
  assert.ok(s.arrivals>=16);assert.ok(s.actors.filter(a=>a.moving).length>=12);
});

test('player and patrol share solid bodies and the patrol submits its own validated move commands',async()=>{
  const flat={...world,spawn:{x:-2,z:0},blockers:[
    {id:'north',minX:-12,maxX:12,minZ:.75,maxZ:12,minY:0,maxY:3},
    {id:'south',minX:-12,maxX:12,minZ:-12,maxZ:-.75,minY:0,maxY:3},
  ]};
  const create=createCharacterAuthorityFactory(flat);
  const player=create(0,undefined,undefined,{id:'local-player',ownerId:'local'});
  const connection=createLocalConnection(player);
  const npc=createNpcAuthority(flat,[{...patrol,points:[[2,0],[-6,0]]}],1,0,'npc',(tick,spawn,identity)=>{
    const actor=create(tick,spawn,undefined,identity);
    const wrongOwner=actor.receive({type:'move',characterId:identity.id,sequence:1,tick,x:0,z:0,run:false,jump:false},'local');
    assert.equal(wrongOwner.reason,'owner');
    return actor;
  });
  try {
    for(let tick=1;tick<=90;tick++){
      const playerState=connection.snapshot();
      const receipt=connection.send({type:'move',characterId:playerState.id,sequence:tick,tick:playerState.tick,
        x:1,z:0,run:true,jump:tick===40,locomotion:{boost:true,lift:0,flight:null}});
      connection.step(tick);
      npc.step(tick);
      assert.ok((await receipt).accepted);
      const p=connection.snapshot(),n=npc.snapshot().actors[0];
      assert.ok(n.x-p.x>=.7-1e-7,'Sprint or jump penetrated an NPC');
      assert.equal(n.lastSequence,tick);
    }
    const before=connection.snapshot().x;
    assert.ok(before>1 && before<1.4);
    npc.dispose();
    for(let tick=91;tick<=105;tick++){
      const receipt=connection.send({type:'move',characterId:'local-player',sequence:tick,tick:tick-1,x:1,z:0,run:true,jump:false});
      connection.step(tick);
      assert.ok((await receipt).accepted);
    }
    assert.ok(connection.snapshot().x>before+1);
  } finally {
    npc.dispose();
    connection.close();
    player.dispose();
  }
});


test('a patrol turns by command and takes a local detour around a stationary player',()=>{
  const flat={...world,spawn:{x:0,z:0},blockers:[]};
  const create=createCharacterAuthorityFactory(flat);
  const player=create(0,undefined,undefined,{id:'local-player',ownerId:'local'});
  const mirror=createLocalConnection(createCharacterAuthorityFactory(flat)(0,{x:-6,z:0}));
  const npc=createNpcAuthority(flat,[patrol],1,0,'npc',(tick,spawn,identity)=>{
    const actor=create(tick,spawn,undefined,identity);
    return {...actor,receive(input:unknown,owner:string){
      assert.ok(input&&typeof input==='object'&&'x' in input&&'z' in input&&'facing' in input);
      const {x,z,facing}=input;
      assert.ok(typeof x==='number'&&typeof z==='number'&&typeof facing==='number');
      if(Math.hypot(x,z)>1e-6){
        const angle=Math.atan2(x,z)-facing;
        assert.ok(Math.abs(Math.atan2(Math.sin(angle),Math.cos(angle)))<1e-8,'NPC stepped sideways before finishing its turn');
      }
      const state=mirror.snapshot();
      void mirror.send({type:'move',characterId:state.id,sequence:state.tick+1,tick:state.tick,x,z,run:false,jump:false,facing});
      return actor.receive(input,owner);
    }};
  });
  let before=npc.snapshot().actors[0],detour=0;
  for(let tick=1;tick<=500;tick++){
    player.step(tick);npc.step(tick);mirror.step(tick);
    const position=npc.snapshot().actors[0];
    const controlled=mirror.snapshot();
    assert.deepEqual([position.x,position.y,position.z,position.yaw],[controlled.x,controlled.y,controlled.z,controlled.yaw]);
    const turn=Math.atan2(Math.sin(position.yaw-before.yaw),Math.cos(position.yaw-before.yaw));
    assert.ok(Math.abs(turn)<=.12+1e-9);
    assert.ok(Math.abs(position.x)>=.7-1e-7||Math.abs(position.z)>=.7-1e-7);
    assert.ok(Math.hypot(position.x-before.x,position.z-before.z)<=.03+1e-7);
    detour=Math.max(detour,Math.abs(position.z));
    before=position;
  }
  assert.ok(detour>=.7);
  assert.ok(npc.snapshot().arrivals>=1);
  npc.dispose();player.dispose();mirror.close();
});


test('local detours go around low props without stepping onto them',()=>{
  const flat={...world,spawn:{x:0,z:0},blockers:[
    {id:'low-north',minX:-.6,maxX:.6,minZ:.65,maxZ:1.4,minY:0,maxY:.24},
    {id:'low-south',minX:-.6,maxX:.6,minZ:-1.4,maxZ:-.65,minY:0,maxY:.24},
  ]};
  const create=createCharacterAuthorityFactory(flat);
  const player=create(0,undefined,undefined,{id:'local-player',ownerId:'local'});
  const npc=createNpcAuthority(flat,[patrol],1,0,'npc',(tick,spawn,identity)=>create(tick,spawn,undefined,identity));
  for(let tick=1;tick<=600;tick++){
    player.step(tick);npc.step(tick);
    const actor=npc.snapshot().actors[0];
    assert.equal(actor.y,0);
    assert.equal(actor.grounded,true);
  }
  assert.ok(npc.snapshot().arrivals>=1);
  npc.dispose();player.dispose();
});

test('a patrol resumes on the first tick after a moving blocker clears',()=>{
  const flat={...world,spawn:{x:2,z:.71},blockers:[]};
  const create=createCharacterAuthorityFactory(flat);
  const player=create(0,undefined,undefined,{id:'local-player',ownerId:'local'});
  const route={...patrol,points:[[-2,0],[2,0]]};
  const npc=createNpcAuthority(flat,[route],1,0,'npc',(tick,spawn,identity)=>create(tick,spawn,undefined,identity));
  try {
    for(let tick=1;tick<=75;tick++){player.step(tick);npc.step(tick);}
    const before=npc.snapshot().actors[0];
    assert.ok(before.x>-.4&&before.x<.6);
    for(const [tick,z] of [[76,-1],[77,1]] as const){
      const s=player.snapshot();
      assert.ok(player.receive({type:'move',characterId:s.id,sequence:tick,tick:s.tick,x:0,z,run:false,jump:false},s.ownerId).accepted);
      player.step(tick);npc.step(tick);
      if(tick===76)assert.equal(npc.snapshot().actors[0].x,before.x);
      else assert.ok(npc.snapshot().actors[0].x>before.x);
    }
    player.dispose();
    for(let tick=78;tick<=210;tick++)npc.step(tick);
    assert.ok(npc.snapshot().arrivals>=1);
  } finally {npc.dispose();player.dispose();}
});

test('presentation keeps NPC speed even when frames alternate between one and two simulation ticks',()=>{
  const clock=createLocalAuthority();
  let previous={x:0,z:0},current=previous;
  clock.addSystem(tick=>{previous=current;current={x:tick*.03,z:0};});
  clock.advance(STEP_MS*2);
  let position=interpolateNpcPosition(previous,current,clock.frameProgress());
  for(let frame=0;frame<40;frame++){
    const delta=frame%2===0?STEP_MS*1.25:STEP_MS*1.75;
    clock.advance(delta);
    const next=interpolateNpcPosition(previous,current,clock.frameProgress());
    assert.ok(Math.abs(next.x-position.x-1.8*delta/1000)<1e-9);
    position=next;
  }
  clock.advance(10000);
  assert.equal(clock.frameProgress(),1);
});
