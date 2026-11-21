import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { getBuildingInteriorSources } from '../src/modules/world/building-profiles.ts';
import { citySource } from '../src/modules/world/city.ts';
import { cityCollision } from '../src/modules/world/headless.ts';
import { generateCity } from '../src/modules/world-generation/headless.ts';
import { ONLINE_DAY_MS, onlineDayHour, onlineDayPhase } from '../src/simulation/daylight.ts';
import { PROTOCOL, readVehicle, type VehicleCommand, type VehicleSnapshot } from '../src/simulation/online-protocol.ts';
import { startRoom } from './room.ts';

type Actor = { id: string; x: number; z: number; lastSequence: number; moving: boolean; vehicleId?: string; vehicleAnimation?: string };
type Packet = { type: string; id: string; token: string; epoch: string; tick: number; dayPhaseMs: number; sequence: number;
  accepted: boolean; reason: string; players: Actor[]; vehicle: VehicleSnapshot };

async function connect(url: string, origin: string, world: string, characterId: string, token?: string) {
  const socket = new WebSocket(url, { origin });
  const packets: Packet[] = [];
  socket.on('message', bytes => packets.push(JSON.parse(bytes.toString())));
  await once(socket, 'open');
  function send(value: object) { socket.send(JSON.stringify(value)); }
  async function next(matches: (packet: Packet) => boolean, timeout = 3000) {
    const end = performance.now() + timeout;
    do {
      const index = packets.findIndex(matches);
      if (index >= 0) return packets.splice(index, 1)[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (performance.now() < end);
    assert.fail('Expected room packet was not received');
  }
  send({ type: 'join', protocol: PROTOCOL, world, token, characterId, accessToken: 'test-'+characterId });
  const welcome = await next(packet => packet.type === 'welcome');
  return { socket, welcome, send, next };
}

test('two WebSockets share the city, reject invalid input and resume a player', { timeout: 15_000 }, async () => {
  const origin = 'http://127.0.0.1:5175';
  const city = generateCity(citySource);
  const world = `${city.id}/${city.version}`;
  const room = startRoom(cityCollision(city), world, 0, origin, async (token, id) => token === 'test-'+id, undefined, getBuildingInteriorSources(city));
  try {
    await once(room.server, 'listening');
    const address = room.server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `ws://127.0.0.1:${address.port}/room`;
    const denied = new WebSocket(url, { origin: 'https://other.example' });
    await once(denied, 'error');
    async function rejected(characterId: string, accessToken: string, expectedCode: number) {
      const socket = new WebSocket(url, { origin });
      await once(socket, 'open');
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ type: 'join', protocol: PROTOCOL, world, characterId, accessToken }));
      assert.equal((await closed)[0], expectedCode);
    }
    await rejected('one', 'test-two', 4003);
    const a = await connect(url, origin, world, 'one');
    const b = await connect(url, origin, world, 'two');
    await rejected('one', 'test-one', 4004);
    assert.notEqual(a.welcome.id, b.welcome.id);
    assert.equal(a.welcome.epoch, b.welcome.epoch);
    assert.ok(onlineDayPhase(b.welcome.dayPhaseMs - a.welcome.dayPhaseMs + ONLINE_DAY_MS) < 3000);
    const shared = await a.next(packet => packet.type === 'frame' && packet.players.length === 2);
    const sameTick = await b.next(packet => packet.type === 'frame' && packet.tick === shared.tick);
    assert.equal(sameTick.dayPhaseMs, shared.dayPhaseMs);
    const start = b.welcome.players.find(actor => actor.id === a.welcome.id)!;
    const before = await a.next(packet => packet.type === 'frame' && packet.players.length === 2 && packet.tick >= 31);
    const command = { type: 'move', characterId: a.welcome.id, sequence: 1, tick: before.tick, x: 1, z: 0, run: false, jump: false };
    const reply = (client: typeof a, sequence: number) => client.next(packet => packet.type === 'receipt' && packet.sequence === sequence);
    b.send({ type: 'input', command });
    assert.equal((await reply(b, 1)).reason, 'invalid');
    a.send({ type: 'input', command: { ...command, tick: 0 } });
    assert.equal((await reply(a, 1)).reason, 'stale');
    a.send({ type: 'input', command });
    assert.equal((await reply(a, 1)).accepted, true);
    a.send({ type: 'input', command });
    assert.equal((await reply(a, 1)).reason, 'sequence');
    await b.next(packet => packet.type === 'frame' && packet.players.some(actor => actor.id === start.id && actor.x > start.x));
    const sentAt = await a.next(packet => packet.type === 'frame' && packet.tick > before.tick + 3);
    // The newer command arrives first after jitter. Sequence 4 is never delivered.
    const delayed = setTimeout(() => a.send({
      type: 'input', command: { ...command, sequence: 2, tick: sentAt.tick },
    }), 75);
    try {
      a.send({ type: 'input', command: { ...command, sequence: 3, tick: sentAt.tick } });
      assert.equal((await reply(a, 3)).accepted, true);
      assert.equal((await reply(a, 2)).reason, 'sequence');
    } finally { clearTimeout(delayed); }
    const recovered = await a.next(packet => packet.type === 'frame' && packet.tick >= sentAt.tick + 6);
    a.send({ type: 'input', command: { ...command, sequence: 5, tick: recovered.tick } });
    assert.equal((await reply(a, 5)).accepted, true);
    const closed = once(a.socket, 'close');
    a.socket.close();
    await closed;
    await b.next(packet => packet.type === 'frame' && packet.players.some(actor =>
      actor.id === start.id && actor.lastSequence === 5 && !actor.moving));
    const resumed = await connect(url, origin, world, a.welcome.id, a.welcome.token);
    assert.equal(resumed.welcome.id, a.welcome.id);
    assert.equal(resumed.welcome.epoch, a.welcome.epoch);
    assert.equal(resumed.welcome.players.find(actor => actor.id === start.id)?.lastSequence, 5);
  } finally { await room.close(); }
});


test('online daylight advances one game hour every five minutes and wraps at midnight', () => {
  assert.equal(onlineDayHour(5 * 60 * 1000), 1);
  assert.equal(onlineDayHour(60 * 60 * 1000), 12);
  assert.equal(onlineDayHour(ONLINE_DAY_MS + 5 * 60 * 1000), 1);
});

test('two clients receive the same room-level entrance state', { timeout: 8000 }, async () => {
  const origin='http://localhost:5175';
  const collision={
    spawn:{x:0,z:2},baseHeight:0,slopeX:0,bounds:{minX:-20,maxX:20,minZ:-20,maxZ:20},
    floors:[],blockers:[],doors:[{id:'door',x:0,y:0,z:0,tx:1,tz:0,width:2.5,height:2.75}],
  };
  const room=startRoom(collision,'door-test',0,origin,async()=>true,undefined,[],[{id:'door',left:.25,right:.25}]);
  try {
    assert.deepEqual(room.doorSnapshot(),[{id:'door',left:.25,right:.25}]);
    await once(room.server,'listening');
    const address=room.server.address();
    assert.ok(address && typeof address!=='string');
    const url=`ws://127.0.0.1:${address.port}/room`;
    async function connect(characterId:string) {
      const socket=new WebSocket(url,{origin});
      await once(socket,'open');
      const frames=new Map<number,unknown>();
      socket.on('message',bytes=>{
        const packet=JSON.parse(bytes.toString());
        if(packet.type==='frame')frames.set(packet.tick,packet.doors);
      });
      socket.send(JSON.stringify({type:'join',protocol:PROTOCOL,world:'door-test',characterId,accessToken:'test'}));
      return frames;
    }
    const first=await connect('one'),second=await connect('two');
    for(let attempt=0;attempt<40;attempt++){
      const common=[...second].find(([tick,doors])=>first.has(tick)&&JSON.stringify(doors).includes('"left":1'));
      if(common){
        assert.deepEqual(common[1],first.get(common[0]));
        assert.deepEqual(common[1],[{id:'door',left:1,right:1}]);
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.fail('Shared entrance did not fully open');
  } finally { await room.close(); }
});

test('players cannot run through one another and can back away after contact', { timeout: 10_000 }, async () => {
  const origin='http://localhost:5175';
  const collision={
    spawn:{x:-2,z:6},baseHeight:0,slopeX:0,bounds:{minX:-20,maxX:20,minZ:-20,maxZ:20},
    floors:[],blockers:[],
  };
  let spawning=0;
  const room=startRoom(collision,'contact-test',0,origin,async()=>true,undefined,[],[],
    () => ({x:spawning++ ? 2 : -2,z:0}));
  try {
    await once(room.server,'listening');
    const address=room.server.address();
    assert.ok(address && typeof address!=='string');
    const url=`ws://127.0.0.1:${address.port}/room`;
    let direction=1;
    const frames: Packet[]=[];
    async function join(characterId:string, otherSide:boolean) {
      const socket=new WebSocket(url,{origin});
      await once(socket,'open');
      let seq=0, lastTick=-6;
      const welcome=once(socket,'message');
      socket.on('message',bytes=>{
        const packet:Packet=JSON.parse(bytes.toString());
        if(packet.type!=='frame')return;
        if(!otherSide)frames.push(packet);
        if(packet.players.length!==2||packet.tick-lastTick<6)return;
        lastTick=packet.tick;
        const x=otherSide ? (direction===1?-1:0) : direction;
        socket.send(JSON.stringify({type:'input',command:{
          type:'move',characterId,sequence:++seq,tick:packet.tick,x,z:0,run:true,jump:false,
        }}));
      });
      socket.send(JSON.stringify({type:'join',protocol:PROTOCOL,world:'contact-test',characterId,accessToken:'test'}));
      await welcome;
    }
    await join('left',false);
    await join('right',true);
    function poses(packet:Packet) {
      return [packet.players.find(player=>player.id==='left')!,packet.players.find(player=>player.id==='right')!];
    }
    async function observe(matches:(packet:Packet)=>boolean) {
      for(let attempt=0;attempt<90;attempt++){
        const packet=frames.find(frame=>frame.players.length===2&&matches(frame));
        if(packet)return packet;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.fail('Expected contact state did not appear');
    }
    const contact=await observe(packet=>{
      const [left,right]=poses(packet);
      return right.x-left.x<.9 && left.lastSequence>0 && right.lastSequence>0 && !left.moving && !right.moving;
    });
    const held=await observe(packet=>packet.tick>=contact.tick+30);
    assert.deepEqual(poses(held).map(actor=>actor.x),poses(contact).map(actor=>actor.x));
    for(const packet of frames.filter(frame=>frame.players.length===2)){
      const [left,right]=poses(packet);
      assert.ok(right.x-left.x>=.7-1e-8);
    }
    direction=-1;
    const retreated=await observe(packet=>packet.tick>held.tick&&poses(packet)[0].x<poses(contact)[0].x-.5);
    assert.equal(poses(retreated)[1].x,poses(contact)[1].x);
  } finally { await room.close(); }
});

test('two sockets share one authoritative car through contention, pedestrian contact and reconnect', { timeout: 65_000 }, async () => {
  const origin = 'http://localhost:5175';
  const world = 'vehicle-test';
  const collision = {
    spawn: { x: 0, z: 0 }, baseHeight: 0, slopeX: 0,
    bounds: { minX: -40, maxX: 40, minZ: -40, maxZ: 40 }, floors: [],
    blockers: [{ id: 'wall', minX: -3, maxX: 10, minY: 0, maxY: 4, minZ: 7, maxZ: 8 }],
  };
  let spawns = 0;
  const room = startRoom(collision, world, 0, origin, async (token, id) => token === 'test-' + id,
    undefined, [], [], () => spawns++ ? { x: 3.5, z: 5.8 } : { x: 0, z: 0 });
  try {
    await once(room.server, 'listening');
    const address = room.server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `ws://127.0.0.1:${address.port}/room`;
    const a = await connect(url, origin, world, 'one');
    const b = await connect(url, origin, world, 'two');
    assert.ok(readVehicle(a.welcome.vehicle, a.welcome.tick));
    function send(client: typeof a, command: VehicleCommand) {
      client.send({ type: 'input', command });
      return client.next(packet => packet.type === 'receipt' && packet.sequence === command.sequence);
    }
    const joined = await a.next(packet => packet.type === 'frame' && packet.players.length === 2 && packet.tick >= 120);
    const base = { characterId: 'one', vehicleId: 'car/0', tick: joined.tick };
    assert.equal((await send(b, { ...base, sequence: 101, type: 'enter' })).reason, 'invalid');
    assert.equal((await send(a, { ...base, sequence: 2, type: 'enter' })).reason, 'accepted');
    assert.equal((await send(b, { ...base, characterId: 'two', sequence: 102, type: 'enter' })).reason, 'unavailable');
    // An earlier intent is delivered after the first accepted one.
    assert.equal((await send(a, { ...base, sequence: 1, type: 'enter' })).reason, 'sequence');
    const seated = await a.next(packet => packet.type === 'frame' && packet.vehicle.phase === 'driving');
    const same = await b.next(packet => packet.type === 'frame' && packet.tick === seated.tick);
    assert.deepEqual(same.vehicle, seated.vehicle);
    assert.equal(same.vehicle.driverId, 'one');
    assert.equal(same.players.find(actor => actor.id === 'one')?.vehicleAnimation, 'driving');
    assert.equal(same.players.find(actor => actor.id === 'two')?.vehicleId, undefined);
    const throttle = { ...base, type: 'drive' as const, throttle: 1, steer: 0, brake: false };
    assert.equal((await send(b, { ...throttle, characterId: 'two', sequence: 103, tick: seated.tick })).reason, 'driver');
    let driven = seated;
    const footZ = same.players.find(actor => actor.id === 'two')!.z;
    let sequence = 3; // The next accepted command also skips the dropped sequence 3.
    for (let run = 0; run < 17; run++) {
      assert.equal((await send(a, { ...throttle, tick: driven.tick, sequence: ++sequence })).accepted, true);
      const nextTick = driven.tick + 6;
      driven = await a.next(packet => packet.type === 'frame' && packet.tick >= nextTick);
      assert.ok(driven.vehicle.position[2] < footZ - 1.9, 'driven car cannot cross the hero');
    }
    assert.ok(driven.vehicle.position[2] > seated.vehicle.position[2] + 2);
    const stopped = await a.next(packet => packet.type === 'frame' && packet.tick >= driven.tick + 30 && packet.vehicle.speed < .8);
    const closed = once(a.socket, 'close');
    a.socket.close();
    await closed;
    const resumed = await connect(url, origin, world, 'one', a.welcome.token);
    assert.equal(resumed.welcome.vehicle.driverId, 'one');
    assert.equal(resumed.welcome.players.find(actor => actor.id === 'one')?.lastSequence, sequence);
    assert.ok(resumed.welcome.tick >= stopped.tick);
    assert.equal((await send(resumed, { ...base, tick: resumed.welcome.tick, sequence: ++sequence, type: 'exit' })).accepted, true);
    const parked = await b.next(packet => packet.type === 'frame' && packet.tick > resumed.welcome.tick && packet.vehicle.phase === 'parked');
    assert.equal(parked.vehicle.driverId, null);
    assert.equal(parked.players.find(actor => actor.id === 'one')?.vehicleId, undefined);

    const ready = await resumed.next(packet => packet.type === 'frame' && packet.tick >= parked.tick && packet.vehicle.speed < .6);
    assert.equal((await send(resumed, { ...base, type: 'enter', tick: ready.tick, sequence: ++sequence })).reason, 'accepted');
    const drivingAgain = await resumed.next(packet => packet.type === 'frame' && packet.tick > ready.tick && packet.vehicle.phase === 'driving');
    const disconnected = once(resumed.socket, 'close');
    resumed.socket.close();
    await disconnected;
    const expired = await b.next(packet => packet.type === 'frame' && packet.tick > drivingAgain.tick && packet.players.length === 1, 33_000);
    assert.equal(expired.vehicle.driverId, null);
  } finally { await room.close(); }
});
