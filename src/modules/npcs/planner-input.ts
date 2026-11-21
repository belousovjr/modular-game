import type { CitySource, CityMesh } from '../world-generation/index.ts';
import type { BuildingInteriorSource, CollisionWorld } from '../world/index.ts';
import { isNpcSurface } from './headless.ts';
import type { PlannerData } from './planner-protocol.ts';

const NUMBERS_PER_PACKET=48_000;
const meshSize=(mesh:CityMesh)=>mesh.positions.length+mesh.indices.length+(mesh.uvs?.length??0);

function* pieces(city:CitySource,world:CollisionWorld,buildings:()=>readonly BuildingInteriorSource[]) {
  for (const chunk of city.chunks) for (const mesh of chunk.meshes) {
    if (isNpcSurface(mesh.surface)) yield {weight:meshSize(mesh),data:{kind:'surface',meshes:[mesh]} satisfies PlannerData};
  }
  for (const road of city.roads)
    yield {weight:road.points.length*3+12,data:{kind:'roads',roads:[road]} satisfies PlannerData};
  for (const walk of city.trafficLayout?.crosswalks??[])
    yield {weight:walk.outline.length*3+10,data:{kind:'crosswalks',crosswalks:[
      {center:walk.center,direction:walk.direction,outline:walk.outline},
    ]} satisfies PlannerData};
  for (const blocker of world.blockers)
    yield {weight:(blocker.outline?.length??0)*3+10,data:{kind:'blockers',blockers:[blocker]} satisfies PlannerData};
  for (const door of world.doors??[])
    yield {weight:10,data:{kind:'doors',doors:[door]} satisfies PlannerData};
  for (const source of buildings()) {
    const {surface,positions,indices,uvs}=source.facade;
    yield {weight:meshSize(source.facade)+source.profile.outline.length*12+50,
      data:{kind:'interiors',interiors:[{...source,facade:{surface,positions,indices,uvs}}]} satisfies PlannerData};
  }
}

export function* plannerPackets(city:CitySource,world:CollisionWorld,buildings:()=>readonly BuildingInteriorSource[]) {
  let batch:PlannerData[]=[],weight=0;
  for (const piece of pieces(city,world,buildings)) {
    if (batch.length&&(weight+piece.weight>NUMBERS_PER_PACKET || batch.length>=128)) {
      yield batch;
      batch=[];
      weight=0;
    }
    batch.push(piece.data);
    weight+=piece.weight;
  }
  if (batch.length) yield batch;
}
