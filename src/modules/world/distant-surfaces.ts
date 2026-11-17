import type {CitySource} from '../world-generation/index.ts';

export const distantSurfaces=new Set(['urban-ground','terrain','road','sidewalk','water','riverbed']);

// shortcut: surfaces currently use world-metre UVs; revisit batching if authored UVs are introduced.
// Keep the canonical terrain triangles; merge their 128 m tiles to avoid distant per-tile draws.
export function groupDistantSurfaces(city:CitySource){
  const groups=new Map<string,{id:string;surface:string;positions:number[];indices:number[]}>();
  for(const chunk of city.chunks)for(const mesh of chunk.meshes){
    if(!distantSurfaces.has(mesh.surface))continue;
    const x=Math.floor((chunk.bounds.minX+chunk.bounds.maxX)*.5/1024),z=Math.floor((chunk.bounds.minZ+chunk.bounds.maxZ)*.5/1024);
    const id=`${city.id}/ground/${x}/${z}/${mesh.surface}`;
    let group=groups.get(id);
    if(!group){group={id,surface:mesh.surface,positions:[],indices:[]};groups.set(id,group);}
    const offset=group.positions.length/3;
    for(const value of mesh.positions)group.positions.push(value);
    for(const index of mesh.indices)group.indices.push(index+offset);
  }
  return [...groups.values()];
}
