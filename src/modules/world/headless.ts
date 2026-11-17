import type { Rectangle, WorldPlacement, CitySource } from '../world-generation/headless.ts';

export interface CollisionBox extends Rectangle { readonly id: string; readonly minY: number; readonly maxY: number; readonly outline?: readonly (readonly number[])[] }
export interface CollisionWorld {
  readonly bounds: Rectangle;
  readonly baseHeight: number;
  readonly slopeX: number;
  readonly blockers: readonly CollisionBox[];
  readonly floors: readonly (Rectangle & { readonly elevation: number })[];
  readonly triangles?: readonly (readonly number[])[];
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

export function cityCollision(city:CitySource):CollisionWorld {
  const triangles:number[][]=[];
  for(const chunk of city.chunks)for(const mesh of chunk.meshes) {
    if(['water','bank','marking','facade','foundation','metal','roof'].includes(mesh.surface)||mesh.surface.startsWith('city-'))continue;
    for(let i=0;i<mesh.indices.length;i+=3) {
      const a=mesh.indices[i]*3,b=mesh.indices[i+1]*3,c=mesh.indices[i+2]*3;
      if(Math.abs((mesh.positions[b]-mesh.positions[a])*(mesh.positions[c+2]-mesh.positions[a+2])-(mesh.positions[c]-mesh.positions[a])*(mesh.positions[b+2]-mesh.positions[a+2]))<1e-8)continue;
      triangles.push([mesh.positions[a],mesh.positions[a+1],mesh.positions[a+2],mesh.positions[b],mesh.positions[b+1],mesh.positions[b+2],mesh.positions[c],mesh.positions[c+1],mesh.positions[c+2]]);
    }
  }
  const furniture=city.placements.flatMap(p=>{
    const size=p.templateId==='city/bench'?[3,.75,1.25]:p.templateId==='city/planter'?[5,2.5,.75]:p.templateId==='city/bollard'?[.5,.5,1]:null;
    if(!size)return [];
    const [x,y,z]=p.position, [width,depth,height]=size;
    const c=Math.cos(p.rotation[1]),s=Math.sin(p.rotation[1]);
    const outline=[[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2]].map(([u,v])=>[x+u*c+v*s,z-u*s+v*c]);
    return [{id:p.key,minX:Math.min(...outline.map(v=>v[0])),maxX:Math.max(...outline.map(v=>v[0])),minZ:Math.min(...outline.map(v=>v[1])),maxZ:Math.max(...outline.map(v=>v[1])),minY:y,maxY:y+height,outline}];
  });
  const trees=city.placements.filter(p=>p.templateId==='city/tree'&&!p.key.startsWith('authored/tree/planter/')).map(p=>{
    const [x,y,z]=p.position;
    const radius=p.parameters.height*.022;
    return {id:p.key,minX:x-radius,maxX:x+radius,minZ:z-radius,maxZ:z+radius,minY:y,maxY:y+p.parameters.height*.72};
  });
  const blockers=[...city.colliders,...furniture,...trees,...city.placements.filter(p=>p.templateId==='world/lamp'||p.templateId==='city/signal').flatMap(p=>{
    const [x,y,z]=p.position;
    const pole={id:p.key,minX:x-.125,maxX:x+.125,minZ:z-.125,maxZ:z+.125,minY:y-.125,maxY:y+(p.templateId==='city/signal'?6.75:4.375)};
    return p.templateId==='world/lamp'?[pole,{id:`${p.key}/base`,minX:x-.25,maxX:x+.25,minZ:z-.25,maxZ:z+.25,minY:y-.125,maxY:y+.375}]:[pole];
  })];
  return Object.freeze({bounds:Object.freeze({...city.bounds}),baseHeight:-40,slopeX:0,spawn:Object.freeze({...city.spawn}),blockers,floors:[],triangles});
}
