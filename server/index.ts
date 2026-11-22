import { createRoomNpcs } from './npcs.ts';
import { createNpcNavigation } from '../src/modules/npcs/headless.ts';
import { citySource } from '../src/modules/world/city.ts';
import { cityCollision } from '../src/modules/world/headless.ts';
import { getBuildingInteriorSources } from '../src/modules/world/building-profiles.ts';
import { splitCityDetails } from '../src/modules/world/detail-assets.ts';
import { generateCity } from '../src/modules/world-generation/headless.ts';
import { readFileSync } from 'node:fs';
import { openRoomMap } from './terrain-tiles.ts';
import { createDoorStore } from './world-doors.ts';
import { existsSync } from 'node:fs';
import { createAccounts } from './account.ts';
import { startRoom } from './room.ts';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
const accounts = createAccounts(process.env);
const maps = new URL('../artifacts/room-map/', import.meta.url);
const map = openRoomMap(new URL(readFileSync(new URL('current',maps),'utf8'),maps));
const port = Number(process.env.GAME_PORT ?? 5177);
const host = process.env.GAME_HOST ?? '127.0.0.1';
const origin = process.env.GAME_ORIGIN ??
  (host === '127.0.0.1' ? ['http://127.0.0.1:5175', 'http://localhost:5175'] : []);
const { world } = map;
const roomId = process.env.GAME_ROOM_ID ?? 'local';
const store = process.env.DATABASE_URL && createDoorStore(process.env.DATABASE_URL, `${roomId}/${world}`);
const restored = store ? await store.load() : [];
function navigation() {
  const city=generateCity(citySource);
  if(`${city.id}/${city.version}`!==world)throw new Error('Room NPC map is out of date. Run npm run prepare:room.');
  return createNpcNavigation(city,cityCollision(city),getBuildingInteriorSources(splitCityDetails(city,()=>'')));
}
const npcs=await createRoomNpcs(navigation(),`${roomId}/${world}`,process.env.DATABASE_URL);
const room = startRoom(map.collision, world, port, origin,
  (token, id) => accounts?.owns(token, id) ?? Promise.resolve(false), host, [], restored, undefined, map.terrain, map.prefetch, npcs);
const metricsTimer = setInterval(() => {
  const metrics = room.takeMetrics();
  if (metrics.players || metrics.outboundSnapshotBytes) {
    const { rss, heapUsed } = process.memoryUsage();
    console.info('Game room metrics', JSON.stringify({ windowSeconds: 30, rss, heapUsed, collisionTiles: map.loadedTerrainTiles(), ...metrics }));
  }
}, 30_000);
metricsTimer.unref();
let saved = room.doorSnapshot();
let writing: Promise<void> | undefined;
function checkpoint() {
  if (writing) return writing;
  const poses = room.doorSnapshot();
  if (!store || poses === saved) return;
  writing = store.save(poses).then(() => { saved = poses; }).finally(() => { writing = undefined; });
  return writing;
}
const checkpointTimer = setInterval(() => {
  void checkpoint()?.catch(() => console.error('Could not save world door checkpoint'));
}, 1000);
room.server.on('listening', () => console.log(`Game room listening on ${host}:${port}/room for ${origin}`));
room.server.once('error', error => { console.error(error.message); process.exit(1); });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(checkpointTimer);
  clearInterval(metricsTimer);
  void (async () => {
    await room.close();
    try {
      await writing?.catch(() => {});
      await checkpoint();
    } finally {
      await Promise.all([npcs.close(), accounts?.close(), store ? store.close() : undefined]);
    }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
