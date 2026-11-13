import type { WorldScheme, WorldPlacement } from '../world-generation/index.ts';

export const scheme: WorldScheme = {
  id: 'first-district', seed: 2026,
  bounds: { minX: -550, maxX: 550, minZ: -550, maxZ: 550 },
  baseHeight: 0.3, slopeX: 0.015, lampSpacing: 20,
  streets: Array.from({ length: 11 }, (_, index) => (index - 5) * 96).flatMap(coordinate => [
    { id: `east-west-${coordinate}`, axis: 'x', coordinate, width: 6, sidewalk: 2 },
    { id: `north-south-${coordinate}`, axis: 'z', coordinate, width: 6, sidewalk: 2 },
  ]),
  reserved: [{ minX: 6, maxX: 14, minZ: 6, maxZ: 14 }],
};

export const insertions: readonly WorldPlacement[] = [{
  key: 'first-district/author-plaza', templateId: 'world/plaza', parameters: {},
  position: [10, scheme.baseHeight + scheme.slopeX * 10 + 0.2, 10], rotation: [0, 0, 0],
}];
