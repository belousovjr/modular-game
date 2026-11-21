import {containsBuildingFootprint} from './footprint.ts';
import {facadeDoorWindows} from './facade-door-windows.ts';
import {collectFacadeBelts, facadeTrim} from './facade-trim.ts';
import type {CitySource} from '../world-generation/index.ts';

interface BuildingBatch {
  surface:string;
  positions:number[];
  indices:number[];
  uvs?:number[];
  trim?:number[];
  doorWindows?:number[];
  buildings?:number[];
}

export function groupBuildingSurfaces(city:CitySource) {
  const buildings=new Map(city.colliders.map((footprint,index)=>[footprint.id,{footprint,key:index+1}]));
  const groups=new Map<string,{buildingIds:string[];meshes:Map<string,BuildingBatch>}>();
  for(const chunk of city.chunks){
    const sources=chunk.meshes.filter(mesh=>mesh.surface.startsWith('city-'));
    if(!sources.length)continue;
    const owners=chunk.buildingIds.flatMap(id=>{
      const building=buildings.get(id);
      return building?[building]:[];
    });
    const panels = (chunk.details??[]).flatMap(detail=>detail.meshes.filter(mesh=>mesh.surface==='facade').map(mesh=>mesh.positions));
    const belts=collectFacadeBelts(chunk.details??[]);
    const x=Math.floor(chunk.bounds.minX/512);
    const z=Math.floor(chunk.bounds.minZ/512);
    const id=`${city.id}/skyline/${x}/${z}`;
    let group=groups.get(id);
    if(!group){
      group={buildingIds:[],meshes:new Map()};
      groups.set(id,group);
    }
    group.buildingIds.push(...chunk.buildingIds);
    for(const source of sources){
      const key=`${source.surface}/${source.uvs?'fitted':'plain'}`;
      let mesh=group.meshes.get(key);
      if(!mesh){
        mesh={surface:source.surface,positions:[],indices:[],uvs:source.uvs?[]:undefined,trim:source.uvs?[]:undefined};
        group.meshes.set(key,mesh);
      }
      const first=mesh.positions.length/3;
      if (owners.length && !mesh.buildings) mesh.buildings=Array(first).fill(0);
      if (mesh.buildings) for (let i=0;i<source.positions.length;i+=3) {
        const [x,y,z]=[source.positions[i],source.positions[i+1],source.positions[i+2]];
        const owner=owners.find(({footprint})=>y<=footprint.maxY && containsBuildingFootprint(footprint,x,z));
        mesh.buildings.push(owner?.key??0);
      }
      for(const value of source.positions)mesh.positions.push(value);
      for(const index of source.indices)mesh.indices.push(first+index);
      if(mesh.uvs&&source.uvs)for(const value of source.uvs)mesh.uvs.push(value);
      const rectangles = facadeDoorWindows(source, panels);
      if (rectangles && !mesh.doorWindows) mesh.doorWindows = Array(first*4).fill(0);
      if (mesh.doorWindows) {
        for (let i=0; i<source.positions.length/3*4; i++) mesh.doorWindows.push(rectangles?.[i] ?? 0);
      }
      if(mesh.trim)for(const value of facadeTrim(source,belts))mesh.trim.push(value);
    }
  }
  return Array.from(groups,([id,group])=>({id,buildingIds:group.buildingIds,meshes:[...group.meshes.values()]}));
}
