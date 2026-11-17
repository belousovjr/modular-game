import type {CitySource} from '../world-generation/index.ts';

export const distantSurfaces=new Set(['urban-ground','terrain','park-path','water','riverbed','bank']);

// shortcut: surfaces currently use world-metre UVs; revisit batching if authored UVs are introduced.
// Keep the canonical terrain triangles; merge their 128 m tiles to avoid distant per-tile draws.
export function groupDistantSurfaces(city:CitySource){
  return groupSurfaces(city,false);
}
export function groupStreetSurfaces(city:CitySource){
  return groupSurfaces(city,true);
}
function groupSurfaces(city:CitySource,streetOnly:boolean){
  const groups=new Map<string,{id:string;surface:string;positions:number[];indices:number[]}>();
  for(const chunk of city.chunks)for(const mesh of chunk.meshes){
    const underlay=mesh.surface==='road'||mesh.surface==='sidewalk'||mesh.surface==='curb';
    if(streetOnly?mesh.surface!=='sidewalk':!distantSurfaces.has(mesh.surface)&&!underlay)continue;
    const surface=underlay&&!streetOnly?(mesh.surface==='road'?'road-base':'urban-ground'):mesh.surface;
    const span=streetOnly?256:1024;
    const x=Math.floor((chunk.bounds.minX+chunk.bounds.maxX)*.5/span),z=Math.floor((chunk.bounds.minZ+chunk.bounds.maxZ)*.5/span);
    const id=`${city.id}/${streetOnly?'street':'ground'}/${x}/${z}/${surface}`;
    let group=groups.get(id);
    if(!group){group={id,surface,positions:[],indices:[]};groups.set(id,group);}
    if(mesh.surface==='curb'){
      const p=mesh.positions,remap=new Map<number,number>();
      for(let i=0;i<mesh.indices.length;i+=3){
        const a=mesh.indices[i]*3,b=mesh.indices[i+1]*3,c=mesh.indices[i+2]*3;
        if(Math.abs((p[b]-p[a])*(p[c+2]-p[a+2])-(p[c]-p[a])*(p[b+2]-p[a+2]))<1e-8)continue;
        for(const vertex of [a,b,c]){
          let index=remap.get(vertex);
          if(index===undefined){
            index=group.positions.length/3;
            group.positions.push(p[vertex],p[vertex+1]-.25,p[vertex+2]);
            remap.set(vertex,index);
          }
          group.indices.push(index);
        }
      }
      continue;
    }
    const offset=group.positions.length/3;
    // Remove the pavement lift; road material uses native depth bias above this continuous base.
    const drop=underlay&&!streetOnly&&mesh.surface==='sidewalk'?.25:0;
    for(let i=0;i<mesh.positions.length;i++)group.positions.push(mesh.positions[i]-(i%3===1?drop:0));
    for(const index of mesh.indices)group.indices.push(index+offset);
  }
  return [...groups.values()];
}
