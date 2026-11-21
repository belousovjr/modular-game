import { existsSync } from 'node:fs';
import { createAccounts } from './account.ts';
import { citySource } from '../src/modules/world/city.ts';
import { cityCollision } from '../src/modules/world/headless.ts';
import { generateCity } from '../src/modules/world-generation/headless.ts';
import { startRoom } from './room.ts';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
const accounts = createAccounts(process.env);
const city = generateCity(citySource);
const port = Number(process.env.GAME_PORT ?? 5177);
const host = process.env.GAME_HOST ?? '127.0.0.1';
const origin = process.env.GAME_ORIGIN ??
  (host === '127.0.0.1' ? ['http://127.0.0.1:5175', 'http://localhost:5175'] : []);
const room = startRoom(cityCollision(city), `${city.id}/${city.version}`, port, origin, (token, id) => accounts?.owns(token, id) ?? Promise.resolve(false), host);
room.server.on('listening', () => console.log(`Game room listening on ${host}:${port}/room for ${origin}`));
room.server.once('error', error => { console.error(error.message); process.exit(1); });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  void room.close().then(() => accounts?.close()).catch(error => { console.error(error.message); process.exitCode = 1; });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
