import type { WorldScheme, WorldPlacement, WorldRegion } from '../world-generation/index.ts';
import data from './data/river-north.json' with { type: 'json' };

export const scheme: WorldScheme = {
  id: 'river-north', seed: 2026, bounds: data.bounds,
  baseHeight: 0.3, slopeX: 0.015, lampSpacing: 20,
  streets: data.streets.map(street => {
    if (street.axis !== 'x' && street.axis !== 'z') throw new Error('Некорректная ось улицы River North');
    return { ...street, axis: street.axis };
  }),
  reserved: [{ minX: 6, maxX: 14, minZ: 6, maxZ: 14 }],
};

export const regions: readonly WorldRegion[] = [
  { id: 'river-north/south-west', bounds: { ...scheme.bounds, maxX: 0, maxZ: 0 } },
  { id: 'river-north/south-east', bounds: { ...scheme.bounds, minX: 0, maxZ: 0 } },
  { id: 'river-north/north-west', bounds: { ...scheme.bounds, maxX: 0, minZ: 0 } },
  { id: 'river-north/north-east', bounds: { ...scheme.bounds, minX: 0, minZ: 0 } },
];

export const insertions: readonly WorldPlacement[] = [{
  key: 'first-district/author-plaza', templateId: 'world/plaza', parameters: {},
  position: [10, scheme.baseHeight + scheme.slopeX * 10 + 0.2, 10], rotation: [0, 0, 0],
}];
