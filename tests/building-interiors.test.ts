import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import {floorInRange, partitionInterior} from '../src/modules/building-interiors/floor-lod.ts';
import {floorOpenings, type Point} from '../src/modules/building-interiors/floor-openings.ts';
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

test('each surviving window has one pane inside the reveal and door openings have none', () => {
  const {glazing} = buildInterior(source);
  assert.equal(glazing.indices.length,2*6);
  for (let i=0;i<glazing.positions.length;i+=3) {
    assert.ok(glazing.positions[i]>0 && glazing.positions[i]<.25);
    assert.ok(glazing.positions[i+1]>4);
  }
});

test('window reveal edges are perpendicular to the inner face at either end of a wall', () => {
  const profile = {...source.profile, entrance:{...source.profile.entrance,wallIndex:1}};
  const {positions,ceilingStart} = buildInterior({...source,profile});
  let depthEdges=0;
  for (let face=0;face<ceilingStart/6;face++) {
    for (let side=0;side<4;side++) {
      const a=(face*4+side)*3, b=(face*4+(side+1)%4)*3;
      const lo=Math.min(positions[a],positions[b]), hi=Math.max(positions[a],positions[b]);
      if (lo!==0 || hi!==.25 || positions[a+1]!==positions[b+1]) continue;
      assert.ok(Math.abs(positions[a+2]-positions[b+2])<1e-9);
      depthEdges++;
    }
  }
  assert.equal(depthEdges,32);
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

test('inset walls and reveals stay inside a complex authored facade', () => {
  const source = getBuildingInteriorSources(citySource).find(source=>source.profile.shape==='complex' &&
    source.profile.facades.length>=20);
  assert.ok(source);
  const facade=source.facade;
  const roof: number[][] = [];
  for (let i=0;i<facade.indices.length;i+=3) {
    const triangle=facade.indices.slice(i,i+3);
    if (triangle.every(vertex=>facade.uvs?.[vertex*2]===-2)) roof.push(triangle.map(vertex=>vertex*3));
  }
  assert.ok(roof.length>0);
  const {positions,indices,ceilingStart}=buildInterior(source);
  const contains = (x:number,z:number) => roof.some(([a,b,c])=>{
    const edge = (from:number,to:number) => {
      const dx=facade.positions[to]-facade.positions[from], dz=facade.positions[to+2]-facade.positions[from+2];
      return dx*(z-facade.positions[from+2])-dz*(x-facade.positions[from])>=-.0025*Math.hypot(dx,dz);
    };
    return edge(a,b)&&edge(b,c)&&edge(c,a);
  });
  const inspected=new Set<string>();
  for (let i=0;i<ceilingStart;i+=3) for (let edge=0;edge<3;edge++) {
    const a=indices[i+edge]*3, b=indices[i+(edge+1)%3]*3;
    for (const fraction of [0,.5]) {
      const x=positions[a]+(positions[b]-positions[a])*fraction;
      const z=positions[a+2]+(positions[b+2]-positions[a+2])*fraction;
      const key=`${x}/${z}`;
      if (inspected.has(key)) continue;
      inspected.add(key);
      assert.ok(contains(x,z),`Interior edge outside the facade at ${key}`);
    }
  }
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
    if (normals[i]>.99) up.add(slabs.positions[i]);
    if (normals[i]<-.99) down.add(slabs.positions[i]);
  }
  assert.deepEqual([...up],[threshold+.01,4]);
  assert.deepEqual([...down],[threshold+.01-.25,3.75]);
  assert.ok(3.75-threshold >= 2);
  const cramped = {...profile, floorHeight:1.1, height:2.7};
  assert.equal(buildInterior({...source, profile:cramped}).slabs.indices.length,12);
});

test('slab cutouts match the profile, stay aligned and keep the ground floor closed', () => {
  const profile = {...source.profile, floorCount:3, height:12, elevatorCount:1};
  const {openings,slabs} = buildInterior({...source,profile});
  assert.deepEqual(openings.map(opening=>opening.kind),['staircase','elevator']);
  assert.equal(slabs.stairRims.length,2);
  let area = 0;
  for (let i=0; i<slabs.indices.length; i+=3) {
    const [a,b,c] = slabs.indices.slice(i,i+3).map(index=>index*3);
    if (slabs.positions[a+1]!==4 || slabs.positions[b+1]!==4 || slabs.positions[c+1]!==4) continue;
    const [ax,,az] = slabs.positions.slice(a,a+3);
    const [bx,,bz] = slabs.positions.slice(b,b+3);
    const [cx,,cz] = slabs.positions.slice(c,c+3);
    area += Math.abs((bx-ax)*(cz-az)-(bz-az)*(cx-ax))/2;
  }
  const cutArea = openings.reduce((sum,o)=>sum+(o.maxX-o.minX)*(o.maxZ-o.minZ),0);
  assert.ok(Math.abs(area-(100-cutArea))<1e-6);
  assert.equal(slabs.positions.slice(0,18).filter((value,i)=>i%3===1&&value===.01).length,6);
  for (const opening of openings) {
    for (const height of [4,7.5]) {
      for (const y of [height,height-.25]) {
        assert.ok(slabs.indices.some(index=>{
          const [x,vertexY,z]=slabs.positions.slice(index*3,index*3+3);
          return x===opening.minX && z===opening.minZ && vertexY===y;
        }));
      }
    }
  }
});

test('the nearest stair edge stays six metres from the entrance in a typical footprint', () => {
  const {openings} = buildInterior(source);
  const stair = openings.find(opening=>opening.kind==='staircase');
  assert.ok(stair);
  // Fixture entry is at X=0, facing +X, centered at Z=5.
  const sideGap = Math.max(3.25-stair.maxZ,stair.minZ-6.75,0);
  assert.ok(Math.hypot(stair.minX,sideGap)>=6);
});

test('floor LOD partitions the walls, windows, landing doors and complete slabs by actual floor', () => {
  const profile={...source.profile, floorCount:7,height:25.5,elevatorCount:1};
  const interior=buildInterior({...source,profile});
  const floors=partitionInterior(interior);
  assert.equal(floors.length,7);
  const area=({positions,indices}:{positions:number[];indices:number[]})=>{
    let result=0;
    for (let i=0;i<indices.length;i+=3) {
      const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;
      const x=positions[b]-positions[a],y=positions[b+1]-positions[a+1],z=positions[b+2]-positions[a+2];
      const u=positions[c]-positions[a],v=positions[c+1]-positions[a+1],w=positions[c+2]-positions[a+2];
      result+=Math.hypot(y*w-z*v,z*u-x*w,x*v-y*u)/2;
    }
    return result;
  };
  assert.ok(Math.abs(floors.reduce((sum,floor)=>sum+area(floor.walls),0)-area(interior))<1e-6);
  for (const [index,floor] of floors.entries()) {
    assert.ok(floor.walls.positions.every((value,i)=>i%3!==1 || (value>=floor.minY && value<=floor.maxY)));
    assert.equal(floor.stairRims.length,index===0?0:1);
    assert.equal(floor.doors.indices.length,12);
    assert.equal(floor.doors.uvs?.length,floor.doors.positions.length/3*2);
    assert.equal(floor.glass.indices.length,index===0?0:12);
    assert.equal(floor.slab.indices.length,(interior.slabs.floorStarts[index+1]??interior.slabs.indices.length)-interior.slabs.floorStarts[index]);
  }
  assert.equal(floorInRange(floors[0],floors[0].maxY+7,3.5),true);
  assert.equal(floorInRange(floors[0],floors[0].maxY+7.001,3.5),false);
  assert.equal(floorInRange(floors[6],1,3.5),false);
});

test('elevator shafts have inward and outward wall faces and flush landing doors', () => {
  const profile = {...source.profile, floorCount:3, height:12, elevatorCount:1};
  const {positions,indices,openings,elevatorDoors} = buildInterior({...source,profile});
  const shaft = openings.find(opening=>opening.kind==='elevator');
  assert.ok(shaft?.front!==undefined);
  const axis = shaft.front%2===0 ? 2 : 0;
  const plane = [shaft.minZ,shaft.maxX,shaft.maxZ,shaft.minX][shaft.front];
  assert.ok(elevatorDoors.positions.every((value,i)=>i%3!==axis || Math.abs(value-plane)<1e-9));
  assert.equal(elevatorDoors.indices.length,3*12);
  const thresholds = new Set<number>();
  for (let i=1; i<elevatorDoors.positions.length; i+=12) thresholds.add(elevatorDoors.positions[i]);
  assert.deepEqual([...thresholds],[.01,4,7.5]);
  const shaftWall = (height:number) => positions.some((x,i)=>i%3===0 &&
    Math.abs(x-shaft.minX)<1e-9 && Math.abs(positions[i+2]-shaft.minZ)<1e-9 && positions[i+1]===height);
  assert.ok(shaftWall(.01) && shaftWall(11.5));
  const normals: number[] = [];
  VertexData.ComputeNormals(positions,indices,normals);
  // Pick a solid wall opposite to the landing if its door faces negative Z.
  const direction=shaft.front===0 ? 1 : -1;
  const outerZ=direction===1 ? shaft.maxZ : shaft.minZ;
  const innerZ=outerZ-direction*.12;
  const face = (z:number,sign:number) => positions.some((x,i)=>i%3===0 &&
    x>=shaft.minX && x<=shaft.maxX && Math.abs(positions[i+2]-z)<1e-9 &&
    positions[i+1]===.01 && normals[i+2]*sign>.99);
  assert.ok(face(outerZ,direction) && face(innerZ,-direction));
});

test('the landing door faces across the floor rather than back toward a nearby window', () => {
  const profile = {
    ...source.profile, elevatorCount:1, staircaseCount:0,
    entrance:{...source.profile.entrance,center:[5,0],wallIndex:3},
    facades:source.profile.facades.map((wall,i)=>({...wall,windowColumns:i===1?3:0})),
  };
  const {openings} = buildInterior({...source,profile});
  assert.equal(openings.length,1);
  assert.notEqual(openings[0].front,2);
});

test('lifts form a row near a corner and keep both staircase reservations', () => {
  const footprint: Point[] = [[0,0],[24,0],[24,18],[0,18]];
  const profile = {
    ...source.profile, elevatorCount:4, staircaseCount:2,
    entrance:{...source.profile.entrance,center:[12,0]},
    facades:footprint.map((_,i)=>({start:footprint[(i+1)%4],end:footprint[i],windowColumns:0})),
  };
  const openings = floorOpenings(profile,footprint,[0,1,2,0,2,3]);
  assert.deepEqual(openings.map(o=>o.kind),['staircase','staircase',...Array(4).fill('elevator')]);
  const [first,second]=openings;
  const gap=Math.hypot(Math.max(first.minX-second.maxX,second.minX-first.maxX,0),
    Math.max(first.minZ-second.maxZ,second.minZ-first.maxZ,0));
  assert.ok(gap>=10);
  for (const stair of [first,second]) {
    const x=(stair.minX+stair.maxX)/2, z=(stair.minZ+stair.maxZ)/2;
    const approaches=[
      [x-.5,x+.5,stair.minZ-1.15,stair.minZ],
      [stair.maxX,stair.maxX+1.15,z-.5,z+.5],
      [x-.5,x+.5,stair.maxZ,stair.maxZ+1.15],
      [stair.minX-1.15,stair.minX,z-.5,z+.5],
    ];
    assert.ok(approaches.some(([minX,maxX,minZ,maxZ])=>minX>=0 && maxX<=24 && minZ>=0 && maxZ<=18 &&
      openings.every(other=>other===stair || maxX<=other.minX || minX>=other.maxX || maxZ<=other.minZ || minZ>=other.maxZ)));
  }
  const [anchor,...lifts]=openings.slice(2);
  assert.ok(anchor.minX<1 || anchor.maxX>23);
  assert.ok(anchor.maxZ>17);
  assert.ok(openings.every(opening=>opening.minZ>=8));
  const alongX = anchor.front===0 || anchor.front===2;
  assert.ok(lifts.some(lift=>lift.front===anchor.front &&
    Math.abs(alongX ? lift.minZ-anchor.minZ : lift.minX-anchor.minX)<1e-8));
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
