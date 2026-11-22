import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { generateCity } from '../src/modules/world-generation/headless.ts';
import { cityCollision } from '../src/modules/world/headless.ts';
import { getBuildingInteriorSources } from '../src/modules/world/building-profiles.ts';
import { splitCityDetails } from '../src/modules/world/detail-assets.ts';
import { partitionTerrain, type RoomMap } from '../server/terrain-tiles.ts';
import { isNpcSurface } from '../src/modules/npcs/headless.ts';

const parent = new URL('../artifacts/room-map/', import.meta.url);
const inputs = [
  'src/modules/world/data/downtown/city.json', 'src/modules/world/data/downtown/collision-courtyards.json',
  'src/modules/world/data/downtown/trees.json', 'src/modules/world/data/downtown/building-profiles.json',
  'src/modules/world/city.ts', 'src/modules/world/headless.ts', 'src/modules/world/building-profiles.ts',
  'src/modules/world-generation/headless.ts', 'src/modules/world/detail-assets.ts', 'server/terrain-tiles.ts', 'src/modules/npcs/headless.ts', 'scripts/prepare-room-map.ts',
];
const stamps = await Promise.all(inputs.map(path => stat(new URL('../' + path, import.meta.url)).then(info => [info.size, info.mtimeMs])));
const version = JSON.stringify(stamps);
const current = await readFile(new URL('current', parent), 'utf8').catch(() => '');
if (current && await readFile(new URL('version.json', parent), 'utf8').catch(() => '') === version &&
  await Promise.all(['manifest.json', 'npc.json'].map(file => stat(new URL(current + file, parent))))
    .then(() => true, () => false)) process.exit(0);

const { citySource } = await import('../src/modules/world/city.ts');
const city = generateCity(citySource);
const collision = cityCollision(city);
const interiors = getBuildingInteriorSources(splitCityDetails(city, () => ''));
const tiles = partitionTerrain(collision, interiors);
const directory = new URL(`generation-${process.pid}-${Date.now()}/`, parent);
await mkdir(directory, { recursive: true });
for (const [key, contents] of tiles) await writeFile(new URL(key + '.json', directory), JSON.stringify(contents));
let chunkCount = 0;
for (const chunk of city.chunks) {
  const meshes = chunk.meshes.filter(mesh => isNpcSurface(mesh.surface))
    .map(({ surface, positions, indices }) => ({ surface, positions, indices }));
  if (meshes.length) await writeFile(new URL(`npc-${chunkCount++}.json`, directory), JSON.stringify({ meshes }));
}
const { id, version: cityVersion, bounds, roads, trafficLayout } = city;
await writeFile(new URL('npc.json', directory), JSON.stringify({
  city: { id, version: cityVersion, bounds, roads, trafficLayout },
  world: { spawn: collision.spawn, blockers: collision.blockers, doors: collision.doors },
  interiors, chunkCount,
}));
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
