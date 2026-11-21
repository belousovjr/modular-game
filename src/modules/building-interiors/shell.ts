import type { BuildingProfile, BuildingInteriorSource } from '../world/index.ts';

import { DOOR_FRAME_TRIM, cutFloor, interiorLayout, SLAB_DEPTH, SHAFT_WALL_DEPTH, openingCorners, type Point } from './headless.ts';
export { ENTRANCE_FLOOR_OFFSET } from './headless.ts';
const WALL_DEPTH = .25;
const MULLION_HALF_WIDTH = .012; // Fraction of the exterior facade cell.

function mix(a: readonly number[], b: readonly number[], t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function nearInterior(profile: BuildingProfile, point: {x:number; y:number; z:number}, reach: number) {
  const [ox, oy, oz] = profile.origin;
  const dy = Math.max(oy + Math.min(0, profile.entrance.base) - point.y, 0, point.y - oy - profile.height);
  const limit = reach ** 2 - dy ** 2;
  if (limit < 0) return false;
  const cos = Math.cos(profile.yaw), sin = Math.sin(profile.yaw);
  const x = (point.x - ox) * cos - (point.z - oz) * sin;
  const z = (point.x - ox) * sin + (point.z - oz) * cos;
  let inside = false;
  let [ax, az] = profile.outline[profile.outline.length - 1];
  for (const [bx, bz] of profile.outline) {
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if ((x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2 <= limit) return true;
    if ((az > z) !== (bz > z) && x < ax + dx * (z - az) / dz) inside = !inside;
    ax = bx;
    az = bz;
  }
  return inside;
}

export function interiorViewHeight(profile: BuildingProfile, point: {x:number; y:number; z:number} | null | undefined, preparingEntrance: boolean) {
  if (point && nearInterior(profile, point, preparingEntrance ? 4 : 0)) return point.y;
  return undefined;
}

export function buildInterior({profile, facade}: BuildingInteriorSource) {
  const positions: number[] = [], indices: number[] = [];
  const walls = {positions,indices};
  const glazing = {positions:[] as number[],indices:[] as number[]};
  const mullions = {positions:[] as number[],indices:[] as number[]};
  const [ox, oy, oz] = profile.origin;
  const cos = Math.cos(profile.yaw), sin = Math.sin(profile.yaw);
  const bottom = Math.min(0, profile.entrance.base), top = profile.height - .5;
  const wallNormal = new Map<BuildingProfile['facades'][number], Point>();
  const incoming = new Map<string, {normal:Point; span:number}>();
  const outgoing = new Map<string, {normal:Point; span:number}>();
  for (const wall of profile.facades) {
    const dx = wall.end[0] - wall.start[0], dz = wall.end[1] - wall.start[1];
    const span = Math.hypot(dx, dz);
    const normal: Point = [dz / span, -dx / span];
    wallNormal.set(wall, normal);
    const edge = {normal, span};
    incoming.set(wall.end.join(','), edge);
    outgoing.set(wall.start.join(','), edge);
  }
  function inset(point: readonly number[], normal: Point): Point {
    const key = point.join(',');
    const before = incoming.get(key), after = outgoing.get(key);
    const a = before?.normal ?? normal, b = after?.normal ?? normal;
    const x = a[0]+b[0], z = a[1]+b[1];
    // Keep the miter from folding short edges in concave footprints.
    const limit = Math.min(before?.span ?? Infinity, after?.span ?? Infinity) / 3;
    const scale = Math.min(WALL_DEPTH / Math.max(.5, 1+a[0]*b[0]+a[1]*b[1]), limit / (Math.hypot(x,z) || 1));
    return [point[0] + x*scale, point[1] + z*scale];
  }
  function vertex(point: readonly number[], y: number, target = positions) {
    target.push(ox + point[0]*cos + point[1]*sin, oy + y, oz - point[0]*sin + point[1]*cos);
  }
  function quad(a: readonly number[], ay: number, b: readonly number[], by: number,
    c: readonly number[], cy: number, d: readonly number[], dy: number, target = walls) {
    const first = target.positions.length / 3;
    vertex(a, ay, target.positions); vertex(b, by, target.positions);
    vertex(c, cy, target.positions); vertex(d, dy, target.positions);
    target.indices.push(first, first+1, first+2, first, first+2, first+3);
  }

  for (const [wall, normal] of wallNormal) {
    const start = inset(wall.start, normal), end = inset(wall.end, normal);
    const panel = (left: number, right: number, low: number, high: number) => {
      if (high <= low || right <= left) return;
      const a = mix(start, end, left), b = mix(start, end, right);
      quad(a, low, b, low, b, high, a, high);
    };
    const dx=end[0]-start[0], dz=end[1]-start[1];
    const lengthSquared=dx*dx+dz*dz;
    if (!wall.windowColumns || lengthSquared<1e-10) {
      panel(0, 1, bottom, top);
      continue;
    }
    const innerAlong=(point:readonly number[])=>
      ((point[0]-start[0])*dx+(point[1]-start[1])*dz)/lengthSquared;
    const outerStart=innerAlong(wall.start), outerSpan=innerAlong(wall.end)-outerStart;
    if (outerSpan<=0) {
      panel(0, 1, bottom, top);
      continue;
    }
    const entrance = profile.entrance;
    const entranceWall = wall === profile.facades[entrance.wallIndex];
    const span = Math.hypot(wall.end[0]-wall.start[0],wall.end[1]-wall.start[1]);
    const doorHalf = entrance.width/2+DOOR_FRAME_TRIM;
    let bandBottom = bottom;
    for (let row = 0; row < profile.floorCount; row++) {
      // Match the ordinary facade's ground-floor and upper-floor window masks.
      const halfWidth = row === 0 ? .40 : .32;
      const halfHeight = row === 0 ? .39 : .34;
      const low = profile.facadeBase + (row + .5 - halfHeight)*profile.floorHeight;
      const high = profile.facadeBase + (row + .5 + halfHeight)*profile.floorHeight;
      panel(0, 1, bandBottom, low);
      bandBottom = high;
      let pier = 0;
      for (let column = 0; column < wall.windowColumns; column++) {
        const left = (column + .5 - halfWidth)/wall.windowColumns;
        const right = (column + .5 + halfWidth)/wall.windowColumns;
        if (entranceWall && high > entrance.base && low < entrance.base+entrance.height+DOOR_FRAME_TRIM &&
            right*span > entrance.offset-doorHalf && left*span < entrance.offset+doorHalf) continue;
        // Project the exterior opening onto the actual inner wall. Limit it to the joined wall segment.
        const outerLeft=Math.max(left,-outerStart/outerSpan);
        const outerRight=Math.min(right,(1-outerStart)/outerSpan);
        if (outerRight-outerLeft<1e-8) continue;
        const innerLeft=Math.max(0,outerStart+outerLeft*outerSpan);
        const innerRight=Math.min(1,outerStart+outerRight*outerSpan);
        panel(pier, innerLeft, low, high);
        pier = innerRight;
        const il = mix(start, end, innerLeft), ir = mix(start, end, innerRight);
        const ol = mix(wall.start, wall.end, outerLeft), or = mix(wall.start, wall.end, outerRight);
        quad(il, low, ir, low, or, low, ol, low);
        quad(il, high, ol, high, or, high, ir, high);
        quad(il, low, ol, low, ol, high, il, high);
        quad(ir, low, ir, high, or, high, or, low);
        const center=(column+.5)/wall.windowColumns;
        const barLeft=Math.max(outerLeft,center-MULLION_HALF_WIDTH/wall.windowColumns);
        const barRight=Math.min(outerRight,center+MULLION_HALF_WIDTH/wall.windowColumns);
        if (barRight>barLeft) {
          const across=(t:number,depth:number)=>mix(mix(il,ir,t),mix(ol,or,t),depth);
          const a=(barLeft-outerLeft)/(outerRight-outerLeft), b=(barRight-outerLeft)/(outerRight-outerLeft);
          const fl=across(a,.40), fr=across(b,.40), bl=across(a,.55), br=across(b,.55);
          quad(fl,low,fr,low,fr,high,fl,high,mullions);
          quad(fl,low,fl,high,bl,high,bl,low,mullions);
          quad(fr,low,br,low,br,high,fr,high,mullions);
        }
        const first=glazing.positions.length/3;
        const gl=mix(il,ol,.55), gr=mix(ir,or,.55);
        vertex(gl,low,glazing.positions); vertex(gr,low,glazing.positions);
        vertex(gr,high,glazing.positions); vertex(gl,high,glazing.positions);
        glazing.indices.push(first,first+1,first+2,first,first+2,first+3);
      }
      panel(pier, 1, low, high);
    }
    panel(0, 1, bandBottom, top);
  }

  // Reuse the roof triangulation for every horizontal surface, including courtyard cutouts.
  const {footprint,ground,upperFloors,localFootprint,openings}=interiorLayout({profile,facade});
  function cap(geometry: {positions:number[]; indices:number[]}, height: number, up: boolean) {
    const first = geometry.positions.length / 3;
    for (const i of footprint) geometry.positions.push(facade.positions[i*3], oy+height, facade.positions[i*3+2]);
    for (let i = first; i < first+footprint.length; i += 3) {
      geometry.indices.push(i, i+(up?1:2), i+(up?2:1));
    }
  }

  const slabs = {positions:[] as number[], indices:[] as number[], stairRims:[] as number[], floorStarts:[0]};
  cap(slabs, ground, true);
  cap(slabs, ground-SLAB_DEPTH, false);
  const cut = openings.length ? cutFloor(localFootprint,footprint,openings) : [];
  const slabVertex = (point: Point, y: number) => vertex(point,y,slabs.positions);
  for (const {height,depth} of upperFloors) {
    slabs.floorStarts.push(slabs.indices.length);
    if (!openings.length) {
      cap(slabs,height,true);
      cap(slabs,height-depth,false);
      continue;
    }
    for (let i=0; i<cut.length; i+=3) {
      const first=slabs.positions.length/3;
      const [a,b,c]=cut.slice(i,i+3);
      slabVertex(a,height); slabVertex(b,height); slabVertex(c,height);
      slabVertex(a,height-depth); slabVertex(c,height-depth); slabVertex(b,height-depth);
      slabs.indices.push(first,first+1,first+2,first+3,first+4,first+5);
    }
    for (const opening of openings) {
      // The shaft walls already close the perimeter of their slab cutout.
      if (opening.kind!=='staircase') continue;
      const corners = openingCorners(opening);
      slabs.stairRims.push(slabs.positions.length/3);
      for (let i=0; i<4; i++) {
        const a=corners[i], b=corners[(i+1)%4], first=slabs.positions.length/3;
        slabVertex(a,height-depth); slabVertex(a,height); slabVertex(b,height); slabVertex(b,height-depth);
        slabs.indices.push(first,first+1,first+2,first,first+2,first+3);
      }
    }
  }
  const elevatorDoors = {positions:[] as number[], indices:[] as number[], uvs:[] as number[]};
  function doorLeaf(a: Point, b: Point, low: number, high: number) {
    const first=elevatorDoors.positions.length/3;
    const width=Math.hypot(b[0]-a[0],b[1]-a[1])/2, height=(high-low)/2;
    vertex(a,low,elevatorDoors.positions); vertex(b,low,elevatorDoors.positions);
    vertex(b,high,elevatorDoors.positions); vertex(a,high,elevatorDoors.positions);
    elevatorDoors.indices.push(first,first+1,first+2,first,first+2,first+3);
    elevatorDoors.uvs.push(0,0,width,0,width,height,0,height);
  }
  const levels = [ground,...upperFloors.map(({height})=>height)];
  for (const opening of openings) {
    if (opening.front === undefined) continue;
    const corners=openingCorners(opening);
    const inside=openingCorners({
      minX:opening.minX+SHAFT_WALL_DEPTH, minZ:opening.minZ+SHAFT_WALL_DEPTH,
      maxX:opening.maxX-SHAFT_WALL_DEPTH, maxZ:opening.maxZ-SHAFT_WALL_DEPTH,
    });
    for (let side=0;side<4;side++) {
      const next=(side+1)%4;
      const a=corners[side], b=corners[next], innerA=inside[side], innerB=inside[next];
      const wall = (left:Point,right:Point,inLeft:Point,inRight:Point,low:number,high:number) => {
        if (high<=low) return;
        quad(left,low,right,low,right,high,left,high);
        quad(inRight,low,inLeft,low,inLeft,high,inRight,high);
      };
      if (side!==opening.front) {
        wall(a,b,innerA,innerB,ground,top);
        continue;
      }
      const span=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const halfDoor=Math.min(.55,span/2-.15)/span;
      const left=mix(a,b,.5-halfDoor), right=mix(a,b,.5+halfDoor);
      const insetX=(a[1]-b[1])/span*SHAFT_WALL_DEPTH, insetZ=(b[0]-a[0])/span*SHAFT_WALL_DEPTH;
      const innerLeft:Point=[left[0]+insetX,left[1]+insetZ];
      const innerRight:Point=[right[0]+insetX,right[1]+insetZ];
      for (const [i,low] of levels.entries()) {
        const high=levels[i+1]??top;
        const head=high-(upperFloors[i]?.depth??0);
        const lintel=Math.min(low+2.1,head-.03);
        wall(a,left,innerA,innerLeft,low,high);
        wall(right,b,innerRight,innerB,low,high);
        wall(left,right,innerLeft,innerRight,lintel,high);
        quad(left,low,innerLeft,low,innerLeft,lintel,left,lintel);
        quad(right,low,right,lintel,innerRight,lintel,innerRight,low);
        quad(left,lintel,innerLeft,lintel,innerRight,lintel,right,lintel);
        doorLeaf(left,mix(a,b,.5-.006/span),low,lintel);
        doorLeaf(mix(a,b,.5+.006/span),right,low,lintel);
      }
    }
  }

  const ceilingStart = indices.length;
  cap({positions,indices}, top, false);
  return {positions, indices, ceilingStart, slabs, openings, elevatorDoors, glazing, mullions,
    floorBounds:[oy+Math.min(bottom,ground-SLAB_DEPTH),...upperFloors.map(({height})=>oy+height),oy+top],
  };
}
