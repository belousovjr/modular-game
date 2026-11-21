import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { generateCity } from '../src/modules/world-generation/headless.ts';
import { cityCollision } from '../src/modules/world/headless.ts';
import { getBuildingInteriorSources } from '../src/modules/world/building-profiles.ts';
import { splitCityDetails } from '../src/modules/world/detail-assets.ts';
import { partitionTerrain, type RoomMap } from '../server/terrain-tiles.ts';

const parent = new URL('../artifacts/room-map/', import.meta.url);
const inputs = [
  'src/modules/world/data/downtown/city.json', 'src/modules/world/data/downtown/collision-courtyards.json',
  'src/modules/world/data/downtown/trees.json', 'src/modules/world/data/downtown/building-profiles.json',
  'src/modules/world/city.ts', 'src/modules/world/headless.ts', 'src/modules/world/building-profiles.ts',
  'src/modules/world-generation/headless.ts', 'src/modules/world/detail-assets.ts', 'server/terrain-tiles.ts', 'scripts/prepare-room-map.ts',
];
const stamps = await Promise.all(inputs.map(path => stat(new URL('../' + path, import.meta.url)).then(info => [info.size, info.mtimeMs])));
const version = JSON.stringify(stamps);
const current = await readFile(new URL('current', parent), 'utf8').catch(() => '');
if (current && await readFile(new URL('version.json', parent), 'utf8').catch(() => '') === version &&
  await stat(new URL(current + 'manifest.json', parent)).then(() => true, () => false)) process.exit(0);

const { citySource } = await import('../src/modules/world/city.ts');
const city = generateCity(citySource);
const collision = cityCollision(city);
const tiles = partitionTerrain(collision, getBuildingInteriorSources(splitCityDetails(city, () => '')));
const directory = new URL(`generation-${process.pid}-${Date.now()}/`, parent);
await mkdir(directory, { recursive: true });
for (const [key, contents] of tiles) await writeFile(new URL(key + '.json', directory), JSON.stringify(contents));
const manifest: RoomMap = {
  world: `${city.id}/${city.version}`,
  collision: { ...collision, blockers: [], pedestrianWalls: undefined, pedestrianShells: undefined, triangles: undefined, water: collision.water && { level: collision.water.level, triangles: [] } },
  tiles: [...tiles.keys()],
};
await writeFile(new URL('manifest.json', directory), JSON.stringify(manifest));
const pointer = new URL(`pointer-${process.pid}.tmp`, parent);
await writeFile(pointer, directory.pathname.split('/').at(-2) + '/');
await rename(pointer, new URL('current', parent));
await writeFile(new URL('version.json', parent), version);
console.log(`Prepared ${tiles.size} terrain collision tiles`);
