import type {BuildingProfile} from '../world/index.ts';

export type Point = readonly [number, number];
type Rectangle = {minX:number; minZ:number; maxX:number; maxZ:number};
export type Opening = Rectangle & {kind:'elevator'|'staircase'; front?:number};

export function openingCorners({minX,minZ,maxX,maxZ}: Rectangle): Point[] {
  return [[minX,minZ],[maxX,minZ],[maxX,maxZ],[minX,maxZ]];
}

function overlaps(a: Rectangle, b: Rectangle) {
  return a.minX<b.maxX && a.maxX>b.minX && a.minZ<b.maxZ && a.maxZ>b.minZ;
}
type Side = readonly [axis:0|1, limit:number, sign:number];

function sides(box: Rectangle): Side[] {
  return [[0,box.minX,1],[0,box.maxX,-1],[1,box.minZ,1],[1,box.maxZ,-1]];
}

function split(polygon: readonly Point[], [axis,limit,sign]: Side): [Point[],Point[]] {
  const inside: Point[] = [], outside: Point[] = [];
  let a = polygon[polygon.length-1];
  for (const b of polygon) {
    const da = (a[axis]-limit)*sign, db = (b[axis]-limit)*sign;
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const t = da/(da-db);
      const intersection: Point = axis===0 ? [limit,a[1]+(b[1]-a[1])*t] : [a[0]+(b[0]-a[0])*t,limit];
      inside.push(intersection);
      outside.push(intersection);
    }
    if (db >= 0) inside.push(b);
    if (db <= 0) outside.push(b);
    a = b;
  }
  return [inside,outside];
}

function crossesBox(a: Point, b: Point, planes: readonly Side[]) {
  let from = 0, to = 1;
  for (const [axis,limit,sign] of planes) {
    const start = (a[axis]-limit)*sign, delta = (b[axis]-a[axis])*sign;
    if (delta === 0) {
      if (start < 0) return false;
    } else if (delta > 0) from = Math.max(from,-start/delta);
    else to = Math.min(to,-start/delta);
    if (to < from) return false;
  }
  return true;
}

export function floorOpenings(profile: BuildingProfile, footprint: readonly Point[], triangles: readonly number[]) {
  const boundary = new Map<string, [Point,Point]>();
  for (let i=0; i<triangles.length; i+=3) {
    for (let j=0; j<3; j++) {
      const a=triangles[i+j], b=triangles[i+(j+1)%3];
      const key=a<b?`${a}/${b}`:`${b}/${a}`;
      if (!boundary.delete(key)) boundary.set(key,[footprint[a],footprint[b]]);
    }
  }
  const edges = [...boundary.values()];
  const openings: Opening[] = [];
  if (!edges.length) return openings;
  let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
  for (const [a] of edges) {
    minX=Math.min(minX,a[0]); minZ=Math.min(minZ,a[1]);
    maxX=Math.max(maxX,a[0]); maxZ=Math.max(maxZ,a[1]);
  }
  const [entryX,entryZ] = profile.entrance.center;
  function eligibleCenter(x:number,z:number) {
    if (Math.hypot(x-entryX,z-entryZ)<3) return false;
    let inside=false;
    for (const [[ax,az],[bx,bz]] of edges) {
      if ((az>z)!==(bz>z) && x<ax+(bx-ax)*(z-az)/(bz-az)) inside=!inside;
    }
    return inside;
  }
  const candidates: Point[] = [];
  const step = Math.min(maxX-minX,maxZ-minZ) < 12 ? .5 : 1;
  for (let z=minZ+step/2; z<maxZ; z+=step) {
    for (let x=minX+step/2; x<maxX; x+=step) {
      if (eligibleCenter(x,z)) candidates.push([x,z]);
    }
  }
  candidates.sort(([ax,az],[bx,bz])=>Math.hypot(ax-entryX,az-entryZ)-Math.hypot(bx-entryX,bz-entryZ));

  const landings: Rectangle[] = [];
  function blocked(box: Rectangle) {
    const planes=sides(box);
    return edges.some(([a,b])=>crossesBox(a,b,planes));
  }
  function viewFrom([x,z]: Point, front: number) {
    const across = front%2===0 ? 0 : 1;
    const facing = 1-across;
    const sign = front===1 || front===2 ? 1 : -1;
    const origin = [x,z];
    let distance = Infinity, window = false;
    for (const {start,end,windowColumns} of profile.facades) {
      const span = end[across]-start[across];
      if (span===0) continue;
      const t=(origin[across]-start[across])/span;
      if (t<0 || t>1) continue;
      const hit=sign*(start[facing]+t*(end[facing]-start[facing])-origin[facing]);
      if (hit<=0 || hit>=distance) continue;
      distance=hit;
      const cell=t*windowColumns;
      window=windowColumns>0 && Math.abs(cell-Math.floor(cell)-.5)<.4;
    }
    return {distance, nearbyWindow:window && distance<6};
  }
  function elevatorLanding(box: Opening, rowFront?:number) {
    const cx=(box.minX+box.maxX)/2, cz=(box.minZ+box.maxZ)/2;
    const halfWidth=.5, depth=1.15; // Includes the inset facade's 25 cm thickness.
    const choices = [
      {minX:cx-halfWidth,maxX:cx+halfWidth,minZ:box.minZ-depth,maxZ:box.minZ},
      {minX:box.maxX,maxX:box.maxX+depth,minZ:cz-halfWidth,maxZ:cz+halfWidth},
      {minX:cx-halfWidth,maxX:cx+halfWidth,minZ:box.maxZ,maxZ:box.maxZ+depth},
      {minX:box.minX-depth,maxX:box.minX,minZ:cz-halfWidth,maxZ:cz+halfWidth},
    ];
    const available = choices.map((landing,front)=>({landing,front}))
      .filter(({landing})=>!blocked(landing) && !openings.some(other=>overlaps(landing,other)))
      .map(choice=>({...choice, view:viewFrom([cx,cz],choice.front)}))
      .sort((a,b)=>Number(a.view.nearbyWindow)-Number(b.view.nearbyWindow) || b.view.distance-a.view.distance);
    const best=available[0];
    return rowFront===undefined ? best :
      available.find(choice=>choice.front===rowFront && choice.view.nearbyWindow===best?.view.nearbyWindow);
  }
  function place(kind: Opening['kind'], sizes: readonly Point[], centers: readonly Point[], rowFront?:number) {
    // shortcut: use compact reservations in tight footprints until actual circulation models are available.
    for (const [halfX,halfZ] of sizes) {
      for (const [x,z] of centers) {
        const box: Opening={kind,minX:x-halfX,minZ:z-halfZ,maxX:x+halfX,maxZ:z+halfZ};
        const margin=.4;
        const padded={kind,minX:box.minX-margin,minZ:box.minZ-margin,maxX:box.maxX+margin,maxZ:box.maxZ+margin};
        if (openings.some(o=>overlaps(padded,o)) || landings.some(o=>overlaps(box,o)) || blocked(padded)) continue;
        if (kind==='elevator') {
          const access=elevatorLanding(box,rowFront);
          if (!access) continue;
          box.front=access.front;
          landings.push(access.landing);
        }
        openings.push(box);
        return box;
      }
    }
  }

  const stairSizes: Point[] = [[1.15,2.3],[2.3,1.15],[.85,1.5],[1.5,.85],[.65,1]];
  for (let i=0;i<profile.staircaseCount;i++) place('staircase',stairSizes,candidates);

  const stairCount=openings.length;
  const shaftSizes: Point[] = [[.95,.95],[.7,.7]];
  if (profile.elevatorCount===0) return openings;

  // Try the corners of the interior bounds first. Every reservation still has to fit the actual footprint.
  const corners = candidates.map(point=>({
    point, score: Math.min(point[0]-minX,maxX-point[0])+Math.min(point[1]-minZ,maxZ-point[1]),
  })).sort((a,b)=>a.score-b.score).map(({point})=>point);
  const rows: Opening[][] = [];
  for (let i=0;i<profile.elevatorCount;i++) {
    let next: Opening | undefined;
    for (const row of rows) {
      if (row.length>=4) continue;
      const first=row[0];
      const front=first.front;
      const alongX=front===0 || front===2;
      const edge=(box:Opening)=>alongX ? box.minX : box.minZ;
      const lastEdge=(box:Opening)=>alongX ? box.maxX : box.maxZ;
      const low=Math.min(...row.map(edge)), high=Math.max(...row.map(lastEdge));
      const cross=alongX ? (first.minZ+first.maxZ)/2 : (first.minX+first.maxX)/2;
      const half=(first.maxX-first.minX)/2;
      const rowCenters: Point[] = [];
      // Snap the gap to the placement grid so the shafts share the same facade line.
      const spacing=Math.ceil((2*half+.400001)/step)*step;
      for (const along of [high-half+spacing,low+half-spacing]) {
        rowCenters.push(alongX?[along,cross]:[cross,along]);
      }
      const reserved = rowCenters.filter(([x,z])=>eligibleCenter(x,z));
      next=place('elevator',[[half,half]],reserved,front);
      if (next) {
        row.push(next);
        break;
      }
    }
    if (next) continue;
    const separated = corners.filter(([x,z])=>rows.every(([first])=>
      Math.hypot(x-(first.minX+first.maxX)/2,z-(first.minZ+first.maxZ)/2)>=6));
    const anchor=place('elevator',shaftSizes,separated) ?? place('elevator',shaftSizes,corners);
    if (!anchor) break;
    rows.push([anchor]);
  }
  if (openings.length-stairCount<profile.elevatorCount) {
    // Keep the staircase reservations and recover the configured capacity in irregular footprints.
    openings.length=stairCount;
    landings.length=0;
    for (let i=0;i<profile.elevatorCount;i++) place('elevator',shaftSizes,candidates);
  }
  return openings;
}

export function cutFloor(footprint: readonly Point[], triangles: readonly number[], openings: readonly Opening[]) {
  let polygons: Point[][] = [];
  for (let i=0; i<triangles.length; i+=3) polygons.push(triangles.slice(i,i+3).map(index=>footprint[index]));
  for (const opening of openings) {
    const pieces: Point[][] = [];
    const planes = sides(opening);
    for (const polygon of polygons) {
      if (!planes.every(([axis,limit,sign])=>polygon.some(point=>(point[axis]-limit)*sign>0))) {
        pieces.push(polygon);
        continue;
      }
      let inside=polygon;
      for (const side of planes) {
        const [remaining,outside] = split(inside,side);
        if (outside.length>=3) pieces.push(outside);
        if (remaining.length<3) break;
        inside=remaining;
      }
    }
    polygons=pieces;
  }
  const cut: Point[] = [];
  for (const polygon of polygons) {
    const [a] = polygon;
    for (let i=1; i+1<polygon.length; i++) {
      const b=polygon[i], c=polygon[i+1];
      if (Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))>1e-8) cut.push(a,b,c);
    }
  }
  return cut;
}
