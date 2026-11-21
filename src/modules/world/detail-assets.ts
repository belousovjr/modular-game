import type { CityMesh, CitySource } from '../world-generation/index.ts';

type Chunk = CitySource['chunks'][number];

function structuralFacade(mesh: CityMesh, bottom: number, top: number): CityMesh {
  const { positions, indices, uvs } = mesh;
  const needed = new Set<number>();
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.slice(i, i + 3);
    const u = uvs?.[a * 2];
    const belt = u === -3 && Math.abs(positions[b * 3 + 1] - positions[a * 3 + 1] - .25) <= .0001 &&
      positions[c * 3 + 1] === positions[b * 3 + 1];
    if (u === -2 || belt) needed.add(i);
    const d = indices[i + 5];
    if (b === a + 1 && c === a + 2 && d === a + 3 &&
      Math.abs(positions[a * 3 + 1] - bottom) <= .001 && Math.abs(positions[b * 3 + 1] - top) <= .001) {
      needed.add(i);
      needed.add(i + 3);
    }
  }
  const selected = indices.filter((_, index) => needed.has(index - index % 3));
  const vertices = [...new Set(selected)].sort((a, b) => a - b);
  const remap = new Map(vertices.map((v, index) => [v, index]));
  return {
    ...mesh,
    positions: vertices.flatMap(v => positions.slice(v * 3, v * 3 + 3)),
    indices: selected.map(v => remap.get(v)!),
    ...(uvs ? { uvs: vertices.flatMap(v => uvs.slice(v * 2, v * 2 + 2)) } : {}),
  };
}

export function splitCityDetails(city: CitySource, asset: (index: number, details: NonNullable<Chunk['details']>) => string): CitySource {
  const heights = new Map(city.colliders.map(item => [item.id, item.maxY]));
  const bases = new Map(city.placements.map(item => [item.key, item.position[1]]));
  return { ...city, chunks: city.chunks.map((chunk, index) => {
    if (!chunk.details?.length) return chunk;
    const detailAsset = asset(index, chunk.details);
    return { ...chunk, detailAsset, details: chunk.details.map(detail => {
      const id = detail.id.split('/detail/')[1];
      const base = bases.get(id), height = heights.get(id);
      const meshes = detail.meshes.flatMap(mesh => {
        if (mesh.surface === 'metal') return [];
        if (!mesh.surface.endsWith('-detail') || base === undefined || height === undefined) return [mesh];
        const structure = structuralFacade(mesh, base + .5, height - .5);
        return structure.indices.length ? [structure] : detail.meshes.some(item => item.surface === 'facade') ? [mesh] : [];
      });
      return { ...detail, meshCount: detail.meshes.length, meshes };
    }) };
  }) };
}
