import type { CityMesh } from '../world-generation/index.ts';

export type RoadRecipe = { readonly origin: readonly number[]; readonly offsets: readonly number[]; readonly faces: readonly number[] };
const SCALE = 10_000;

export function buildRoadRecipe(mesh: CityMesh): RoadRecipe | undefined {
  if (mesh.surface !== 'road' || mesh.uvs) return;
  const fixed = mesh.positions.map(value => Math.round(value * SCALE));
  if (fixed.some((value, index) => !Number.isSafeInteger(value) || value / SCALE !== mesh.positions[index])) return;
  const origin = fixed.slice(0, 3);
  return {
    origin, offsets: fixed.map((value, index) => value - origin[index % 3]),
    faces: mesh.indices.map((value, index) => index ? value - mesh.indices[index - 1] : value),
  };
}

export function generateRoad(recipe: RoadRecipe): CityMesh {
  let last = 0;
  return {
    surface: 'road',
    positions: recipe.offsets.map((offset, index) => (recipe.origin[index % 3] + offset) / SCALE),
    indices: recipe.faces.map(delta => last += delta),
  };
}
