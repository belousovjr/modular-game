import type { CitySource } from '../world-generation/index.ts';
import type { BuildingProfile, BuildingInteriorSource } from './headless.ts';
export type { BuildingShape, BuildingProfile, BuildingInteriorSource } from './headless.ts';
import data from './data/downtown/building-profiles.json' with {type:'json'};

const profiles: Readonly<Record<string, (Omit<BuildingProfile, 'shape'> & {readonly shape: string}) | undefined>> = data;

export function getBuildingProfile(id: string): BuildingProfile | undefined {
  const profile = Object.hasOwn(profiles, id) ? profiles[id] : undefined;
  if (!profile) return;
  const {shape} = profile;
  if (shape === 'rectangular' || shape === 'round' || shape === 'oval' || shape === 'complex') return {...profile, shape};
}


export function getBuildingInteriorSources(city: CitySource): BuildingInteriorSource[] {
  const results: BuildingInteriorSource[] = [];
  for (const chunk of city.chunks) for (const detail of chunk.details ?? []) {
    if (!detail.meshes.some(mesh => mesh.surface === 'facade')) continue;
    const id = detail.id.split('/detail/')[1];
    const profile = getBuildingProfile(id);
    const facade = detail.meshes.find(mesh => mesh.surface.endsWith('-detail'));
    if (profile && facade) results.push({id, bounds:detail.bounds, profile, facade});
  }
  return results;
}
