import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {buildInterior, nearInterior} from '../src/modules/building-interiors/shell.ts';
import {getBuildingInteriorSources, type BuildingInteriorSource} from '../src/modules/world/building-profiles.ts';
import {citySource} from '../src/modules/world/city.ts';

const outline = [[0,0],[0,10],[10,10],[10,0]];
const source: BuildingInteriorSource = {
  id:'test', bounds:{minX:0,maxX:10,minZ:0,maxZ:10},
  profile:{
    shape:'rectangular', width:10, depth:10, height:8, aspectRatio:1, origin:[0,0,0], yaw:0, outline,
    floorCount:2, floorHeight:3.5, facadeBase:.5, windowSlots:4,
    facades:outline.map((start,i)=>({start,end:outline[(i+1)%4],windowColumns:i===0?2:0})),
    entrance:{wallIndex:0,offset:5,center:[0,5],base:0,width:2.5,height:2.75},
  },
  facade:{surface:'city-stone-detail',positions:[0,7.75,0,10,7.75,0,10,7.75,10,0,7.75,10],indices:[0,1,2,0,2,3],uvs:Array(8).fill(-2)},
};

test('interior has inward walls, a real window opening with sills, and a down-facing ceiling', () => {
  const {positions,indices,ceilingStart} = buildInterior(source);
  const normals: number[] = [];
  VertexData.ComputeNormals(positions,indices,normals);
  assert.ok(normals[0] > .99);
  const wallCovers = (y:number,z:number) => {
    for (let i=0;i<ceilingStart;i+=3) {
      const vertices=indices.slice(i,i+3).map(v=>v*3);
      if (!vertices.every(v=>positions[v]===.25)) continue;
      const ys=vertices.map(v=>positions[v+1]), zs=vertices.map(v=>positions[v+2]);
      if (y>Math.min(...ys)&&y<Math.max(...ys)&&z>Math.min(...zs)&&z<Math.max(...zs)) return true;
    }
    return false;
  };
  assert.equal(wallCovers(2.25,2.625),false);
  assert.equal(wallCovers(2.25,5),true);
  assert.equal(wallCovers(.5,2.625),true);
  assert.ok(positions.some((value,i)=>i%3===0 && value===0 && normals[i+1]>.99));
  assert.ok(indices.slice(ceilingStart).every(v => normals[v*3+1]<-.99 && positions[v*3+1]===7.5));
});

test('interior proximity keeps an occupied shell and avoids loading distant or overflown buildings', () => {
  const p = source.profile;
  assert.equal(nearInterior(p,{x:5,y:3,z:5},2),true);
  assert.equal(nearInterior(p,{x:-1.9,y:3,z:5},2),true);
  assert.equal(nearInterior(p,{x:-2.1,y:3,z:5},2),false);
  assert.equal(nearInterior(p,{x:5,y:11,z:5},2),false);
});

test('the largest prepared shell fits one surface mesh and retains its ceiling', () => {
  const sources = getBuildingInteriorSources(citySource);
  assert.ok(sources.length > 1000);
  const largest = sources.reduce((a,b)=>a.profile.windowSlots>b.profile.windowSlots?a:b);
  const shell = buildInterior(largest);
  assert.ok(shell.positions.length>0 && shell.positions.length<=900000);
  assert.ok(shell.indices.length > shell.ceilingStart && shell.indices.length<=1800000);
  assert.ok(shell.positions.every(Number.isFinite));
});
