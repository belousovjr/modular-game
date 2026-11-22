import { createRoomNpcs } from './npcs.ts';
import { DEFAULT_NPC_POPULATION } from '../src/modules/npcs/headless.ts';
import { loadRoomNavigation } from './room-navigation.ts';
import { readFileSync } from 'node:fs';
import { openRoomMap } from './terrain-tiles.ts';
import { createDoorStore } from './world-doors.ts';
import { existsSync } from 'node:fs';
import { createAccounts } from './account.ts';
import { startRoom } from './room.ts';
import { createCharactersHandler } from './api/characters.ts';
import { createDbHealth } from './api/db-health.ts';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
const populationValue = process.env.GAME_NPC_POPULATION;
const population = populationValue === undefined ? undefined : Number(populationValue);
if (population !== undefined && (!Number.isInteger(population) || population < 0 || population > DEFAULT_NPC_POPULATION || !populationValue?.trim())) {
  throw new Error(`GAME_NPC_POPULATION must be an integer from 0 to ${DEFAULT_NPC_POPULATION}.`);
}
const accounts = createAccounts(process.env);
const maps = new URL('../artifacts/room-map/', import.meta.url);
const directory = new URL(readFileSync(new URL('current', maps), 'utf8'), maps);
const map = openRoomMap(directory);
const port = Number(process.env.PORT ?? process.env.GAME_PORT ?? 5177);
const host = process.env.GAME_HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const origin = process.env.GAME_ORIGIN?.split(',').map(value=>value.trim()).filter(Boolean) ??
  (host === '127.0.0.1' ? ['http://127.0.0.1:5175', 'http://localhost:5175'] : []);
const { world } = map;
const roomId = process.env.GAME_ROOM_ID ?? 'local';
const store = process.env.DATABASE_URL && createDoorStore(process.env.DATABASE_URL, `${roomId}/${world}`);
const restored = store ? await store.load() : [];
const npcs = await createRoomNpcs(loadRoomNavigation(directory, world), `${roomId}/${world}`, process.env.DATABASE_URL, population);
const dbHealth=createDbHealth(process.env.DATABASE_URL);
const api=new Map([['/api/characters',createCharactersHandler(accounts)],['/api/db-health',dbHealth.handle]]);
const room = startRoom(map.collision, world, port, origin,
  (token, id) => accounts?.owns(token, id) ?? Promise.resolve(false), host, [], restored, undefined, map.terrain, map.prefetch, npcs, accounts?.user, api);
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
      await Promise.all([npcs.close(), accounts?.close(), store ? store.close() : undefined, dbHealth.close()]);
    }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
