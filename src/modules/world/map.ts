import addresses from './data/downtown/addresses.json' with {type:'json'};
import type { CitySource } from '../world-generation/index.ts';

const addressByBuilding: Readonly<Record<string, {street:string; number:string; source:string}>> = addresses;

export function getWorldMap(city: CitySource) {
  const doors = city.chunks.flatMap(chunk => (chunk.details ?? []).flatMap(detail => {
    const panel = detail.meshes.find(mesh => mesh.surface === 'facade');
    if (!panel) return [];
    const id = detail.id.split('/detail/')[1];
    const address = addressByBuilding[id];
    const p = panel.positions;
    return [{
      id, x: (p[0]+p[9])/2, z: (p[2]+p[11])/2,
      address: address ? Object.freeze({street:address.street, number:address.number, estimated:address.source !== 'osm'}) : undefined,
    }];
  }));
  return {
    bounds: city.bounds,
    surfaces: city.chunks.flatMap(chunk => chunk.meshes),
    buildings: city.colliders.map(building => building.outline),
    streets: city.roads,
    doors,
  };
}

export type WorldMap = ReturnType<typeof getWorldMap>;
