import type { CityMesh, CitySource } from '../world-generation/index.ts';
import data from './data/downtown/building-profiles.json' with {type:'json'};

export type BuildingShape = 'rectangular' | 'round' | 'oval' | 'complex';

export interface BuildingProfile {
  readonly shape: BuildingShape;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly aspectRatio: number;
  /** World X/Y/Z and Babylon yaw. Local points below use X/Z in metres. */
  readonly origin: readonly number[];
  readonly yaw: number;
  readonly outline: readonly (readonly number[])[];
  readonly floorCount: number;
  readonly floorHeight: number;
  readonly facadeBase: number;
  readonly windowSlots: number;
  readonly facades: readonly {
    readonly start: readonly number[];
    readonly end: readonly number[];
    readonly windowColumns: number;
  }[];
  readonly entrance: {
    readonly wallIndex: number;
    readonly offset: number;
    readonly center: readonly number[];
    readonly base: number;
    readonly width: number;
    readonly height: number;
  };
}

const profiles: Readonly<Record<string, (Omit<BuildingProfile, 'shape'> & {readonly shape: string}) | undefined>> = data;

export function getBuildingProfile(id: string): BuildingProfile | undefined {
  const profile = Object.hasOwn(profiles, id) ? profiles[id] : undefined;
  if (!profile) return;
  const {shape} = profile;
  if (shape === 'rectangular' || shape === 'round' || shape === 'oval' || shape === 'complex') return {...profile, shape};
}


export interface BuildingInteriorSource {
  readonly id: string;
  readonly bounds: CitySource['bounds'];
  readonly profile: BuildingProfile;
  readonly facade: CityMesh;
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
