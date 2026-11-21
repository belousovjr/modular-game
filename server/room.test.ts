import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { citySource } from '../src/modules/world/city.ts';
import { cityCollision } from '../src/modules/world/headless.ts';
import { generateCity } from '../src/modules/world-generation/headless.ts';
import { ONLINE_DAY_MS, onlineDayHour, onlineDayPhase } from '../src/simulation/daylight.ts';
import { PROTOCOL } from '../src/simulation/online-protocol.ts';
import { startRoom } from './room.ts';

type Actor = { id: string; x: number; lastSequence: number; moving: boolean };
type Packet = { type: string; id: string; token: string; epoch: string; tick: number; dayPhaseMs: number; sequence: number;
  accepted: boolean; reason: string; players: Actor[] };

test('two WebSockets share the city, reject invalid input and resume a player', { timeout: 15_000 }, async () => {
  const origin = 'http://127.0.0.1:5175';
  const city = generateCity(citySource);
  const world = `${city.id}/${city.version}`;
  const room = startRoom(cityCollision(city), world, 0, origin, async (token, id) => token === 'test-'+id);
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
    async function connect(characterId: string, token?: string) {
      const socket = new WebSocket(url, { origin });
      const packets: Packet[] = [];
      socket.on('message', bytes => packets.push(JSON.parse(bytes.toString())));
      await once(socket, 'open');
      function send(value: object) { socket.send(JSON.stringify(value)); }
      async function next(matches: (packet: Packet) => boolean) {
        const end = performance.now() + 3000;
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
    const a = await connect('one');
    const b = await connect('two');
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
    const resumed = await connect(a.welcome.id, a.welcome.token);
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
