import type { CityMesh, CitySource, WorldPlacement } from '../world-generation/index.ts';

export interface StreetAsset {
  readonly meshes: readonly CityMesh[];
  readonly signals: readonly WorldPlacement[];
}

export function splitStreetAssets(city: CitySource, tileSize: number, asset: (index: number, content: StreetAsset) => string): CitySource {
  const signals = city.placements.filter(p => p.templateId === 'city/signal');
  const buckets = new Map<string, { signals: WorldPlacement[]; meshes: CityMesh[] }>();
  function bucket(key: string) {
    let value = buckets.get(key);
    if (!value) { value = { signals: [], meshes: [] }; buckets.set(key, value); }
    return value;
  }
  for (const signal of signals) {
    const [x, , z] = signal.position;
    bucket(`${Math.floor(x / tileSize)}/${Math.floor(z / tileSize)}`).signals.push(signal);
  }
  const chunks = city.chunks.map(chunk => {
    const markings = chunk.meshes.filter(mesh => mesh.surface === 'marking');
    if (!markings.length) return chunk;
    bucket(chunk.id.slice(city.id.length + 1)).meshes.push(...markings);
    return { ...chunk, meshes: chunk.meshes.filter(mesh => mesh.surface !== 'marking') };
  });
  return {
    ...city, chunks,
    trafficLayout: city.trafficLayout && {
      crosswalks: city.trafficLayout.crosswalks.map(({ center, direction, outline }) => ({ center, direction, outline })),
    },
    placements: city.placements.filter(p => p.templateId !== 'city/signal'),
    signalPoles: signals.map(({ key, position }) => ({ key, position })),
    streetAssets: [...buckets].map(([key, content], index) => {
      const [x, z] = key.split('/').map(Number);
      // Include horizontal signal arms that can extend from poles over the edge of a tile.
      const bounds = { minX: x * tileSize - 13, maxX: (x + 1) * tileSize + 13,
        minZ: z * tileSize - 13, maxZ: (z + 1) * tileSize + 13 };
      return { id: `${city.id}/${key}`, path: asset(index, content), bounds, signalCount: content.signals.length, meshCount: content.meshes.length };
    }),
  };
}
