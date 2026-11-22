import type { RoomNpcs } from './npcs.ts';
import { createVehicleAuthority } from '../src/modules/vehicles/headless.ts';
import { createEntranceMotion, type DoorPose } from '../src/modules/building-interiors/headless.ts';
import { onlineDayPhase } from '../src/simulation/daylight.ts';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocket, WebSocketServer } from 'ws';
import { CharacterSpawnBlockedError, characterBody, createCharacterAuthorityFactory } from '../src/modules/characters/headless.ts';
import { createLocalAuthority, STEP_MS } from '../src/simulation/authority.ts';
import { MAX_ROOM_PLAYERS, parsePacket, PROTOCOL, record, SNAPSHOT_TICKS } from '../src/simulation/online-protocol.ts';
import type { TrafficSample } from '../src/simulation/traffic.ts';
import type { TerrainTile } from './terrain-tiles.ts';
import type { BuildingInteriorSource, CollisionWorld } from '../src/modules/world/headless.ts';

export function startRoom(
  collision: CollisionWorld, world: string, port: number, origin: string | readonly string[],
  owns: (accessToken: string, characterId: string) => Promise<boolean>, host = '127.0.0.1',
  interiorSources: readonly BuildingInteriorSource[] = [], restoredDoors: readonly DoorPose[] = [],
  spawnAt: () => CollisionWorld['spawn'] = () => collision.spawn,
  terrain?: (x:number,z:number)=>TerrainTile,
  prefetchTerrain?: (x:number,z:number)=>void,
  npcs?: RoomNpcs,
) {
  let ticks = 0, tickMs = 0, maxTickMs = 0, slowTicks = 0, maxPendingTicks = 0;
  let snapshots = 0, snapshotBytes = 0, outboundSnapshotBytes = 0, serializationMs = 0;
  const origins = new Set(typeof origin === 'string' ? [origin] : origin);
  const doors = createEntranceMotion(collision.doors ?? []);
  doors.restore(restoredDoors);
  const makeActor = createCharacterAuthorityFactory(collision, interiorSources, undefined, doors, terrain);
  const clock = createLocalAuthority();
  const vehicle = createVehicleAuthority(collision, 0, terrain);
  const epoch = randomUUID();
  const dayStart = onlineDayPhase(Date.now());
  const startedAt = performance.now();
  type Player = { id: string; token: string; actor: ReturnType<typeof makeActor>; socket?: WebSocket; expires: number; npcPayload?: string };
  const players = new Map<string, Player>();
  const connections = new Map<WebSocket, { alive: boolean }>();
  const server = new WebSocketServer({
    port, host, path: '/room', maxPayload: 4096, perMessageDeflate: false,
    verifyClient: ({ origin: requestOrigin }: { origin: string }) => origins.has(requestOrigin) && connections.size < MAX_ROOM_PLAYERS * 2,
  });

  function send(socket: WebSocket, data: string) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 64 * 1024) {
      socket.terminate();
      return false;
    }
    socket.send(data);
    return true;
  }

  function frame() {
    return { tick: clock.snapshot().tick, npcTick: npcs?.tick, doors: doors.snapshot(), vehicle: vehicle.snapshot(), dayPhaseMs: onlineDayPhase(dayStart + performance.now() - startedAt), players: [...players.values()].map(player => {
      const { ownerId: _owner, ...state } = player.actor.snapshot();
      return { ...state, lastSequence: Math.max(state.lastSequence, vehicle.lastSequence(player.id)) };
    }) };
  }

  function publishNpcs(player:Player) {
    if(!npcs||!player.socket)return;
    const {tick,...area}=npcs.snapshot(player.actor.snapshot());
    const payload=JSON.stringify(area);
    if(payload===player.npcPayload)return;
    const packet=JSON.stringify({type:'npcs',data:{tick,...area}});
    if(send(player.socket,packet)){
      player.npcPayload=payload;
      outboundSnapshotBytes+=Buffer.byteLength(packet);
    }
  }

  function spawnPlayer(id: string) {
    const spawn = spawnAt();
    const car = vehicle.blocker();
    const occupied = [...players.values()].map(player => player.actor.snapshot());
    for (let ring = 0; ring < 5; ring++) {
      for (let slot = 0; slot < (ring ? 8 : 1); slot++) {
        const x = spawn.x + Math.cos(slot * Math.PI / 4) * ring * 1.5;
        const z = spawn.z + Math.sin(slot * Math.PI / 4) * ring * 1.5;
        if (x > car.minX-.35 && x < car.maxX+.35 && z > car.minZ-.35 && z < car.maxZ+.35) continue;
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
      if (vehicle.driver() === player.id) vehicle.stopInput();
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
        const command = packet.command;
        const vehicleInput = record(command) && 'vehicleId' in command;
        if (vehicleInput) vehicle.observeCharacter(player.actor.snapshot(),
          [...players.values()].filter(peer => peer !== player).map(peer => characterBody(peer.actor.snapshot())));
        const receipt = vehicleInput ? vehicle.receive(command, player.id) : player.actor.receive(command, player.id);
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
      player.npcPayload = undefined;
      player.expires = Infinity;
      if (previous) {
        player.actor.stopInput();
        if (vehicle.driver() === id) vehicle.stopInput();
      }
      previous?.close(4001, 'replaced');
      send(socket, JSON.stringify({ type: 'welcome', protocol: PROTOCOL, world, epoch, token: player.token, id: player.id, ...frame() }));
      publishNpcs(player);
    });
  });

  clock.addSystem(tick => {
    const start = performance.now();
    const roster = [...players.values()];
    const poses = roster.map(player => player.actor.snapshot());
    const driverId = vehicle.driver();
    const bodies = poses.map(characterBody);
    const car = vehicle.trafficOrigin();
    const [carX,,carZ] = car;
    npcs?.step(tick,poses.filter((_,index)=>roster[index].socket),car);
    const nearbyHeroes: TrafficSample[] = poses
      .filter(pose => (!pose.vehicleId || pose.vehicleAnimation === 'approaching') && Math.hypot(pose.x-carX,pose.z-carZ)<12)
      .map(pose => ({ id: pose.id, car: false, point: [pose.x,pose.y,pose.z], yaw: 0, pitch: 0, velocity: [0,0,0] }));
    const vehicleFrame = vehicle.step(tick, poses.find(pose => pose.id === driverId) ?? null, [...nearbyHeroes,...(npcs?.traffic.around(car)??[])],
      bodies.filter((_,index) => poses[index].id !== driverId));
    npcs?.traffic.contacts(vehicle.trafficContacts());
    makeActor.stepSharedDoors(poses.filter((pose,index) => roster[index].socket &&
      !(pose.id === driverId && vehicleFrame.pose)), [vehicleFrame.blocker]);
    for (const [index, { id, actor }] of roster.entries()) {
      actor.setVehicleFrame(id === driverId ? vehicleFrame : { blocker: vehicleFrame.blocker, pose: null, release: null });
      const pose=poses[index];
      const npcBlockers=pose.vehicleId&&pose.vehicleAnimation!=='approaching'?[]:npcs?.traffic.step(npcs.tick,pose)??[];
      actor.setTrafficBlockers([...bodies.filter((_, other) => other !== index),...npcBlockers]);
      actor.step(tick);
      // Later actors in the same tick collide with positions already committed by earlier actors.
      bodies[index] = characterBody(actor.snapshot());
    }
    const duration = performance.now() - start;
    ticks++;
    tickMs += duration;
    if (duration > STEP_MS) slowTicks++;
    maxTickMs = Math.max(maxTickMs, duration);
  });

  let publishedTick = 0, publishedNpcTick = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    for (const [token, player] of players) {
      if (player.expires > now) continue;
      vehicle.forgetCharacter(player.id);
      player.actor.dispose();
      players.delete(token);
    }
    clock.advance(now - previous);
    previous = now;
    const { tick, pendingTicks } = clock.snapshot();
    maxPendingTicks = Math.max(maxPendingTicks, pendingTicks);
    if (!players.size || tick - publishedTick < SNAPSHOT_TICKS) return;
    if (prefetchTerrain) for (const player of players.values()) if (player.socket) {
      const { x, z } = player.actor.snapshot();
      prefetchTerrain(x,z);
    }
    publishedTick = tick;
    const start = performance.now();
    const data = JSON.stringify({ type: 'frame', ...frame() });
    serializationMs += performance.now() - start;
    const bytes = Buffer.byteLength(data);
    snapshots++;
    snapshotBytes += bytes;
    for (const player of players.values()) if (player.socket && send(player.socket, data)) outboundSnapshotBytes += bytes;
    if(npcs && tick-publishedNpcTick>=6){
      publishedNpcTick=tick;
      for(const player of players.values())publishNpcs(player);
    }
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
    vehicle.dispose();
    for (const player of players.values()) player.actor.dispose();
    players.clear();
  });
  return {
    server,
    doorSnapshot: doors.snapshot,
    takeMetrics() {
      const sample = {
        tick: clock.snapshot().tick, players: players.size, ticks,
        avgTickMs: ticks ? tickMs / ticks : 0, maxTickMs, slowTicks, maxPendingTicks,
        snapshots, avgSnapshotBytes: snapshots ? snapshotBytes / snapshots : 0,
        outboundSnapshotBytes, serializationMs,
      };
      ticks = tickMs = maxTickMs = slowTicks = maxPendingTicks = snapshots = snapshotBytes = outboundSnapshotBytes = serializationMs = 0;
      return sample;
    },
    close() {
      for (const socket of connections.keys()) socket.terminate();
      return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
