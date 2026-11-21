import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { WebSocket } from 'ws';

const scenario = process.argv[2];
if (!scenario) {
  for (const name of ['near', 'spread', 'streamed']) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), name], { stdio: 'inherit' });
    const [code] = await once(child, 'exit');
    if (code !== 0) process.exit(code ?? 1);
  }
} else {
  assert.ok(['near','spread','streamed'].includes(scenario));
  const start = performance.now();
  const before = process.memoryUsage();
  const { startRoom } = await import('../server/room.ts');
  const { PROTOCOL, MAX_ROOM_PLAYERS } = await import('../src/simulation/online-protocol.ts');
  let city, map, collision, interiors=[], world;
  if (scenario === 'streamed') {
    const { openRoomMap } = await import('../server/terrain-tiles.ts');
    const base=new URL('../artifacts/room-map/',import.meta.url);
    map=openRoomMap(new URL(readFileSync(new URL('current',base),'utf8'),base));
    ({world,collision}=map);
  } else {
    const { citySource } = await import('../src/modules/world/city.ts');
    const { generateCity } = await import('../src/modules/world-generation/headless.ts');
    const { cityCollision } = await import('../src/modules/world/headless.ts');
    const { getBuildingInteriorSources } = await import('../src/modules/world/building-profiles.ts');
    city=generateCity(citySource);
    collision=cityCollision(city);
    interiors=getBuildingInteriorSources(city);
    world=`${city.id}/${city.version}`;
  }
  const prepared = performance.now();
  const origin = 'http://localhost';
  const roadSpawns = scenario === 'spread' ? city.roads.filter(road => road.layer === 0 && !road.bridge)
    .flatMap(road => road.points.slice(1).map(([x, z], i) => ({
      x: (x + road.points[i][0]) / 2, z: (z + road.points[i][1]) / 2,
    }))) : [];
  let slot = 0;
  const room = startRoom(collision, world, 0, origin, async () => true, undefined, interiors, [], () => {
    if (scenario !== 'spread') return collision.spawn;
    const col = slot % 4, row = Math.floor(slot++ / 4);
    const { minX, maxX, minZ, maxZ } = collision.bounds;
    const x = minX + (maxX - minX) * (.16 + col * .14);
    const z = minZ + (maxZ - minZ) * (.2 + row * .17);
    const distance = point => (point.x - x) ** 2 + (point.z - z) ** 2;
    return roadSpawns.reduce((closest, point) => distance(point) < distance(closest) ? point : closest);
  },map?.terrain,map?.prefetch);
  const sockets = [];
  const moving = new Set();
  try {
    await once(room.server, 'listening');
    const ready = performance.now();
    const loaded = process.memoryUsage();
    const address = room.server.address();
    const url = `ws://127.0.0.1:${address.port}/room`;
    const roster = await Promise.all(Array.from({ length: MAX_ROOM_PLAYERS }, async (_, index) => {
      const characterId = `bench-${index}`;
      const socket = new WebSocket(url, { origin, handshakeTimeout: 3000 });
      sockets.push(socket);
      await once(socket, 'open');
      let sequence = 0, lastTick = -6;
      const joined = new Promise((resolve, reject) => {
        socket.once('close', (code, reason) => reject(new Error(`Join failed: ${code} ${reason}`)));
        socket.on('message', bytes => {
          const packet = JSON.parse(bytes);
          if (packet.type === 'welcome') resolve(packet.players.find(actor => actor.id === characterId));
          if (packet.type !== 'frame') return;
          if (packet.players.find(actor => actor.id === characterId)?.moving) moving.add(characterId);
          if (packet.tick - lastTick < 6) return;
          lastTick = packet.tick;
          const axis = Math.floor(packet.tick / 120) % 4;
          socket.send(JSON.stringify({ type: 'input', command: {
            type: 'move', characterId, sequence: ++sequence, tick: packet.tick,
            x: [1, 0, -1, 0][axis], z: [0, 1, 0, -1][axis], run: index % 2 === 0, jump: false,
          } }));
        });
      });
      socket.send(JSON.stringify({ type: 'join', protocol: PROTOCOL, world, characterId, accessToken: 'benchmark' }));
      return joined;
    }));
    assert.equal(roster.filter(Boolean).length, MAX_ROOM_PLAYERS);
    await pause(2000);
    room.takeMetrics();
    moving.clear();
    const measurementStart = performance.now();
    await pause(5000);
    const measurementMs = performance.now() - measurementStart;
    const metrics = room.takeMetrics();
    assert.equal(metrics.players, MAX_ROOM_PLAYERS);
    assert.ok(moving.size > 0);
    assert.ok(metrics.snapshots > 0 && metrics.outboundSnapshotBytes > 0 && metrics.ticks > 0);
    const diameter = Math.max(...roster.flatMap(a => roster.map(b => Math.hypot(a.x - b.x, a.z - b.z))));
    const memory = process.memoryUsage();
    const mib = bytes => Math.round(bytes / 1024 ** 2);
    console.log(JSON.stringify({
      scenario, map: world, mapPreparationMs: Math.round(prepared - start), roomReadyMs: Math.round(ready - start),
      baselineRssMiB: mib(before.rss), readyRssMiB: mib(loaded.rss), readyHeapMiB: mib(loaded.heapUsed),
      activeRssMiB: mib(memory.rss), activeHeapMiB: mib(memory.heapUsed), measurementMs: Math.round(measurementMs),
      ...metrics, ...(map ? { loadedTiles: map.loadedTerrainTiles(), totalTiles: map.tiles.length } : {}), spawnDiameterMeters: Math.round(diameter), movingPlayers: moving.size, outboundSnapshotKiBPerSecond: Math.round(metrics.outboundSnapshotBytes / 1024 / (measurementMs / 1000)),
    }, null, 2));
  } finally {
    for (const socket of sockets) socket.terminate();
    await room.close();
  }
}
