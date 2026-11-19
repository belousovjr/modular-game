import type {buildInterior} from './shell.ts';

type Surface = {positions:number[]; indices:number[]; uvs?:number[]};
type Vertex = readonly [x:number,y:number,z:number];

function floorAt(bounds: readonly number[], height: number) {
  let low=0, high=bounds.length-2;
  while (low<high) {
    const middle=Math.floor((low+high+1)/2);
    if (height>=bounds[middle]) low=middle;
    else high=middle-1;
  }
  return low;
}

function clip(vertices: readonly Vertex[], height: number, sign: number) {
  const result: Vertex[] = [];
  let a=vertices[vertices.length-1];
  for (const b of vertices) {
    const from=(a[1]-height)*sign, to=(b[1]-height)*sign;
    if ((from<0 && to>0) || (from>0 && to<0)) {
      const t=from/(from-to);
      result.push([a[0]+(b[0]-a[0])*t,height,a[2]+(b[2]-a[2])*t]);
    }
    if (to>=0) result.push(b);
    a=b;
  }
  return result;
}

function splitSurface(source:Surface, bounds:readonly number[], slabStarts?:readonly number[]) {
  const floors=Array.from({length:bounds.length-1},()=>({
    positions:[] as number[],indices:[] as number[],uvs:source.uvs ? [] as number[] : undefined,
    vertices:new Map<number,number>(),
  }));
  let slab=0;
  for (let i=0;i<source.indices.length;i+=3) {
    const a=source.indices[i], b=source.indices[i+1], c=source.indices[i+2];
    const ay=source.positions[a*3+1], by=source.positions[b*3+1], cy=source.positions[c*3+1];
    const low=Math.min(ay,by,cy), high=Math.max(ay,by,cy);
    if (slabStarts && i===slabStarts[slab+1]) slab++;
    const first=slabStarts ? slab : floorAt(bounds,low);
    const last=slabStarts ? slab : floorAt(bounds,high);
    if (first===last || (last===first+1 && high===bounds[last])) {
      const floor=floors[first];
      for (const index of [a,b,c]) {
        let vertex=floor.vertices.get(index);
        if (vertex===undefined) {
          vertex=floor.positions.length/3;
          floor.vertices.set(index,vertex);
          floor.positions.push(source.positions[index*3],source.positions[index*3+1],source.positions[index*3+2]);
          if (source.uvs && floor.uvs) floor.uvs.push(source.uvs[index*2],source.uvs[index*2+1]);
        }
        floor.indices.push(vertex);
      }
      continue;
    }
    // Concrete walls can span storeys. Doors, windows and slab islands already belong to their level.
    const triangle=[a,b,c].map(index=>[source.positions[index*3],source.positions[index*3+1],source.positions[index*3+2]] as const);
    for (let level=first;level<=last;level++) {
      if (high<=bounds[level]) break;
      let polygon=low<bounds[level] ? clip(triangle,bounds[level],1) : triangle;
      if (high>bounds[level+1]) polygon=clip(polygon,bounds[level+1],-1);
      if (polygon.length<3) continue;
      const floor=floors[level], start=floor.positions.length/3;
      for (const vertex of polygon) floor.positions.push(...vertex);
      for (let j=1;j+1<polygon.length;j++) floor.indices.push(start,start+j,start+j+1);
    }
  }
  return floors;
}

export function partitionInterior(interior: ReturnType<typeof buildInterior>) {
  const {floorBounds,slabs,glazing,elevatorDoors}=interior;
  const concrete=splitSurface(interior,floorBounds);
  const floors=splitSurface(slabs,floorBounds,slabs.floorStarts);
  const glass=splitSurface(glazing,floorBounds);
  const doors=splitSurface(elevatorDoors,floorBounds);
  return concrete.map(({vertices: wallVertices,...walls},index)=>{
    const {vertices,...slab}=floors[index];
    const {vertices:glassVertices,...panes}=glass[index];
    const {vertices:doorVertices,...leaves}=doors[index];
    const stairRims=slabs.stairRims.flatMap(start=>{
      const local=vertices.get(start);
      return local===undefined ? [] : [local];
    });
    return {minY:floorBounds[index],maxY:floorBounds[index+1],walls,slab,stairRims,glass:panes,doors:leaves};
  });
}

export function floorInRange(floor:{minY:number;maxY:number}, y:number, floorHeight:number) {
  return Math.max(floor.minY-y,0,y-floor.maxY)<=2*floorHeight;
}
