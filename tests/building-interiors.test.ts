import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {buildInterior, nearInterior} from '../src/modules/building-interiors/shell.ts';
import {getBuildingInteriorSources, type BuildingInteriorSource} from '../src/modules/world/building-profiles.ts';
import {facadeDoorWindows} from '../src/modules/world/facade-door-windows.ts';
import {citySource} from '../src/modules/world/city.ts';

const outline = [[0,0],[0,10],[10,10],[10,0]];
const source: BuildingInteriorSource = {
  id:'test', bounds:{minX:0,maxX:10,minZ:0,maxZ:10},
  profile:{
    shape:'rectangular', width:10, depth:10, height:8, aspectRatio:1, origin:[0,0,0], yaw:0, outline,
    floorCount:2, elevatorCount:0, staircaseCount:1, floorHeight:3.5, facadeBase:.5, windowSlots:4,
    facades:outline.map((start,i)=>({start,end:outline[(i+1)%4],windowColumns:i===0?2:0})),
    entrance:{wallIndex:0,offset:5,center:[0,5],base:0,width:2.5,height:2.75},
  },
  facade:{surface:'city-stone-detail',positions:[0,7.75,0,10,7.75,0,10,7.75,10,0,7.75,10],indices:[0,1,2,0,2,3],uvs:Array(8).fill(-2)},
};

test('interior has inward walls, a real window opening with sills, and a down-facing ceiling', () => {
  const profile = {...source.profile, entrance:{...source.profile.entrance,wallIndex:1}};
  const {positions,indices,ceilingStart} = buildInterior({...source,profile});
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

test('entrance frame suppresses the entire intersecting window on the facade and in the interior', () => {
  const profile = {...source.profile, entrance:{...source.profile.entrance,offset:3}};
  const {positions,indices,ceilingStart} = buildInterior({...source,profile});
  const spans = (y:number,z:number) => {
    for (let i=0; i<ceilingStart; i+=3) {
      const vertices = indices.slice(i,i+3).map(v=>v*3);
      if (!vertices.every(v=>positions[v]===.25)) continue;
      const ys=vertices.map(v=>positions[v+1]), zs=vertices.map(v=>positions[v+2]);
      if (y>Math.min(...ys) && y<Math.max(...ys) && z>Math.min(...zs) && z<Math.max(...zs)) return true;
    }
    return false;
  };
  assert.equal(spans(2.25,1),true); // The affected window is filled even outside the frame.
  assert.equal(spans(2.25,7.5),false);
  assert.equal(spans(5.75,2.5),false);

  const wall = {surface:'city-stone',positions:[0,.5,0,0,7.5,0,0,7.5,10,0,.5,10],
    indices:[0,1,2,0,2,3],uvs:[128,0,128,2,130,2,130,0]};
  const panel = [-.25,0,1.75,-.25,2.75,1.75,-.25,2.75,4.25,-.25,0,4.25];
  const rect=facadeDoorWindows(wall,[panel]);
  assert.ok(rect);
  assert.ok(rect[0]>128 && rect[2]<129 && rect[1]<0 && rect[3]>0 && rect[3]<1);
  assert.deepEqual(rect.slice(0,4),rect.slice(12,16));
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

test('floor slabs start at the door threshold and leave walking clearance across the window grid', () => {
  const threshold = -.25;
  const profile = {...source.profile, entrance:{...source.profile.entrance,base:threshold}};
  const {slabs} = buildInterior({...source,profile});
  const normals: number[] = [];
  VertexData.ComputeNormals(slabs.positions,slabs.indices,normals);
  const up = new Set<number>(), down = new Set<number>();
  for (let i=1;i<slabs.positions.length;i+=3) {
    (normals[i]>0?up:down).add(slabs.positions[i]);
  }
  assert.deepEqual([...up],[threshold+.01,4]);
  assert.deepEqual([...down],[threshold+.01-.25,3.75]);
  assert.ok(3.75-threshold >= 2);
  const cramped = {...profile, floorHeight:1.1, height:2.7};
  assert.equal(buildInterior({...source, profile:cramped}).slabs.indices.length,12);
});

test('character authority enters through a real doorway and is stopped by the wall beside it', async () => {
  const {cityCollision} = await import('../src/modules/world/headless.ts');
  const {createCharacterAuthorityFactory} = await import('../src/modules/characters/headless.ts');
  const world = cityCollision(citySource);
  const factory = createCharacterAuthorityFactory(world);
  const door = world.doors?.find(door=>door.id==='osm/w1176482819/0/0/1');
  assert.ok(door);
  const {x,y,z,tx,tz} = door;
  const nx=tz, nz=-tx;
  function walk(offset: number) {
    const actor = factory(0,{x:x-nx*1.5+tx*offset,z:z-nz*1.5+tz*offset});
    for(let tick=1;tick<=120;tick++){
      if(tick%6===1)assert.ok(actor.receive({type:'move',characterId:'local-player',sequence:tick,tick:tick-1,x:nx,z:nz,run:false,jump:false},'local').accepted);
      actor.step(tick);
    }
    const p=actor.snapshot();
    assert.ok(Math.abs(p.y-y)<.3);
    return (p.x-x)*nx+(p.z-z)*nz;
  }
  assert.ok(walk(0)>1);
  assert.ok(walk(2)<0);
  assert.ok(world.blockers.some(b=>b.id===door.id));
});
