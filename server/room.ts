import { createEntranceMotion, type DoorPose } from '../src/modules/building-interiors/headless.ts';
import { onlineDayPhase } from '../src/simulation/daylight.ts';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { CharacterSpawnBlockedError, createCharacterAuthorityFactory } from '../src/modules/characters/headless.ts';
import { createLocalAuthority, STEP_MS } from '../src/simulation/authority.ts';
import { MAX_ROOM_PLAYERS, parsePacket, PROTOCOL, record, SNAPSHOT_TICKS } from '../src/simulation/online-protocol.ts';
import type { BuildingInteriorSource, CollisionWorld } from '../src/modules/world/headless.ts';

export function startRoom(
  collision: CollisionWorld, world: string, port: number, origin: string | readonly string[],
  owns: (accessToken: string, characterId: string) => Promise<boolean>, host = '127.0.0.1',
  interiorSources: readonly BuildingInteriorSource[] = [], restoredDoors: readonly DoorPose[] = [],
) {
  const origins = new Set(typeof origin === 'string' ? [origin] : origin);
  const doors = createEntranceMotion(collision.doors ?? []);
  doors.restore(restoredDoors);
  const makeActor = createCharacterAuthorityFactory(collision, interiorSources, undefined, doors);
  const clock = createLocalAuthority();
  const epoch = randomUUID();
  const dayStart = onlineDayPhase(Date.now());
  const startedAt = performance.now();
  type Player = { id: string; token: string; actor: ReturnType<typeof makeActor>; socket?: WebSocket; expires: number };
  const players = new Map<string, Player>();
  const connections = new Map<WebSocket, { alive: boolean }>();
  const server = new WebSocketServer({
    port, host, path: '/room', maxPayload: 4096, perMessageDeflate: false,
    verifyClient: ({ origin: requestOrigin }: { origin: string }) => origins.has(requestOrigin) && connections.size < MAX_ROOM_PLAYERS * 2,
  });

  function send(socket: WebSocket, data: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 64 * 1024) {
      socket.terminate();
      return;
    }
    socket.send(data);
  }

  function frame() {
    return { tick: clock.snapshot().tick, doors: doors.snapshot(), dayPhaseMs: onlineDayPhase(dayStart + performance.now() - startedAt), players: [...players.values()].map(player => {
      const { ownerId: _owner, ...state } = player.actor.snapshot();
      return state;
    }) };
  }

  function spawnPlayer(id: string) {
    const occupied = [...players.values()].map(player => player.actor.snapshot());
    for (let ring = 0; ring < 5; ring++) {
      for (let slot = 0; slot < (ring ? 8 : 1); slot++) {
        const x = collision.spawn.x + Math.cos(slot * Math.PI / 4) * ring * 1.5;
        const z = collision.spawn.z + Math.sin(slot * Math.PI / 4) * ring * 1.5;
        if (occupied.some(actor => Math.hypot(actor.x - x, actor.z - z) < 1)) continue;
        try { return makeActor(clock.snapshot().tick, { x, z }, undefined, { id, ownerId: id }); }
        catch (error) { if (!(error instanceof CharacterSpawnBlockedError)) throw error; }
      }
    }
    return undefined;
  }

  server.on('connection', socket => {
    const connection = { alive: true };
    connections.set(socket, connection);
    let player: Player | undefined;
    let joining = false;
    let windowStart = performance.now();
    let messages = 0;
    const handshake = setTimeout(() => socket.terminate(), 5_000);
    socket.on('pong', () => { connection.alive = true; });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      clearTimeout(handshake);
      connections.delete(socket);
      if (player?.socket !== socket) return;
      player.socket = undefined;
      player.actor.stopInput();
      player.expires = performance.now() + 30_000;
    });
    socket.on('message', async (bytes, binary) => {
      const now = performance.now();
      if (now - windowStart >= 1000) { windowStart = now; messages = 0; }
      if (binary || ++messages > 90) { socket.close(1008, 'rate or format'); return; }
      const packet = parsePacket(bytes.toString());
      if (!record(packet)) { socket.close(1008, 'invalid packet'); return; }
      if (player) {
        if (player.socket !== socket || packet.type !== 'input') return;
        const receipt = player.actor.receive(packet.command, player.id);
        if (record(packet.command) && Number.isSafeInteger(packet.command.sequence))
          send(socket, JSON.stringify({ type: 'receipt', sequence: packet.command.sequence, ...receipt }));
        return;
      }
      if (joining) return;
      if (packet.type !== 'join' || packet.protocol !== PROTOCOL || packet.world !== world ||
        typeof packet.accessToken !== 'string' || typeof packet.characterId !== 'string' ||
        (packet.token !== undefined && (typeof packet.token !== 'string' || packet.token.length !== 36))) {
        socket.close(1008, 'incompatible protocol or world');
        return;
      }
      joining = true;
      try {
        if (!await owns(packet.accessToken, packet.characterId)) { socket.close(4003, 'character access denied'); return; }
      } catch {
        socket.close(1011, 'account service unavailable');
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      const id = packet.characterId;
      const existing = players.get(id);
      if (existing?.socket && existing.token !== packet.token) {
        socket.close(4004, 'character already active');
        return;
      }
      if (!existing) {
        if (players.size >= MAX_ROOM_PLAYERS) { socket.close(1013, 'room full'); return; }
        const actor = spawnPlayer(id);
        if (!actor) { socket.close(1013, 'spawn blocked'); return; }
        player = { id, token: randomUUID(), actor, expires: Infinity };
        players.set(id, player);
      } else player = existing;
      clearTimeout(handshake);
      const previous = player.socket;
      player.socket = socket;
      player.expires = Infinity;
      if (previous) player.actor.stopInput();
      previous?.close(4001, 'replaced');
      send(socket, JSON.stringify({ type: 'welcome', protocol: PROTOCOL, world, epoch, token: player.token, id: player.id, ...frame() }));
    });
  });

  clock.addSystem(tick => {
    makeActor.stepSharedDoors([...players.values()].filter(player => player.socket).map(player => player.actor.snapshot()));
    for (const player of players.values()) player.actor.step(tick);
  });

  let publishedTick = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    for (const [token, player] of players) {
      if (player.expires > now) continue;
      player.actor.dispose();
      players.delete(token);
    }
    clock.advance(now - previous);
    previous = now;
    const tick = clock.snapshot().tick;
    if (!players.size || tick - publishedTick < SNAPSHOT_TICKS) return;
    publishedTick = tick;
    const data = JSON.stringify({ type: 'frame', ...frame() });
    for (const player of players.values()) if (player.socket) send(player.socket, data);
  }, STEP_MS);
  const heartbeat = setInterval(() => {
    for (const [socket, connection] of connections) {
      if (!connection.alive) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) { connection.alive = false; socket.ping(); }
    }
  }, 10_000);

  server.once('close', () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const player of players.values()) player.actor.dispose();
    players.clear();
  });
  return {
    server,
    doorSnapshot: doors.snapshot,
    close() {
      for (const socket of connections.keys()) socket.terminate();
      return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
