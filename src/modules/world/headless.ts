import type { Rectangle, WorldPlacement } from '../world-generation/headless.ts';

export interface CollisionBox extends Rectangle { readonly id: string; readonly minY: number; readonly maxY: number }
export interface CollisionWorld {
  readonly bounds: Rectangle;
  readonly baseHeight: number;
  readonly slopeX: number;
  readonly blockers: readonly CollisionBox[];
  readonly floors: readonly (Rectangle & { readonly elevation: number })[];
  readonly spawn: { readonly x: number; readonly z: number };
}

export function createCollisionWorld(placements: readonly WorldPlacement[], bounds: Rectangle, baseHeight: number, slopeX: number): CollisionWorld {
  const blockers: CollisionBox[] = [];
  let spawn = { x:10,z:12 }, spawnDistance = Infinity;
  const floors: (Rectangle & { elevation: number })[] = [];
  for (const p of placements) {
    const [x, y, z] = p.position;
    if (p.templateId === 'world/road' && p.parameters.width > 2 && p.parameters.depth > 2 && Math.hypot(x,z) < spawnDistance) {
      spawn = { x,z }; spawnDistance = Math.hypot(x,z);
    }
    if (p.templateId === 'world/building' || p.templateId === 'world/lamp') {
      const halfX = p.templateId === 'world/lamp' ? 0.15 : p.parameters.width / 2 + 0.3;
      const halfZ = p.templateId === 'world/lamp' ? 0.15 : p.parameters.depth / 2 + 0.3;
      blockers.push(Object.freeze({ id: p.key, minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ,
        minY: y - (p.parameters.foundation ?? 0.2), maxY: y + (p.parameters.height ?? 4.5) }));
    } else if (['world/sidewalk', 'world/curb', 'world/plaza'].includes(p.templateId)) {
      const halfX = (p.parameters.width ?? 6) * Math.cos(p.rotation[2]) / 2;
      const halfZ = (p.parameters.depth ?? 6) / 2;
      if (p.templateId === 'world/plaza') blockers.push(Object.freeze({ id: `${p.key}/monument`, minX:x-1,maxX:x+1,minZ:z-1,maxZ:z+1,minY:y,maxY:y+3 }));
      floors.push(Object.freeze({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ,
        elevation: p.templateId === 'world/curb' || p.templateId === 'world/plaza' ? 0.2 : 0.18 }));
    }
  }
  return Object.freeze({ bounds: Object.freeze({ ...bounds }), baseHeight, slopeX,
    blockers: Object.freeze(blockers), floors: Object.freeze(floors), spawn: Object.freeze(spawn) });
}
