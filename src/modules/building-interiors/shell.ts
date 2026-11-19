import type { BuildingProfile, BuildingInteriorSource } from '../world/index.ts';

type Point = readonly [number, number];
const WALL_DEPTH = .25;

function mix(a: readonly number[], b: readonly number[], t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function nearInterior(profile: BuildingProfile, point: {x:number; y:number; z:number}, reach: number) {
  const [ox, oy, oz] = profile.origin;
  const dy = Math.max(oy - point.y, 0, point.y - oy - profile.height);
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

export function buildInterior({profile, facade}: BuildingInteriorSource) {
  const positions: number[] = [], indices: number[] = [];
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
  function vertex(point: readonly number[], y: number) {
    positions.push(ox + point[0]*cos + point[1]*sin, oy + y, oz - point[0]*sin + point[1]*cos);
  }
  function quad(a: readonly number[], ay: number, b: readonly number[], by: number,
    c: readonly number[], cy: number, d: readonly number[], dy: number) {
    const first = positions.length / 3;
    vertex(a, ay); vertex(b, by); vertex(c, cy); vertex(d, dy);
    indices.push(first, first+1, first+2, first, first+2, first+3);
  }

  for (const [wall, normal] of wallNormal) {
    const start = inset(wall.start, normal), end = inset(wall.end, normal);
    const panel = (left: number, right: number, low: number, high: number) => {
      if (high <= low || right <= left) return;
      const a = mix(start, end, left), b = mix(start, end, right);
      quad(a, low, b, low, b, high, a, high);
    };
    if (!wall.windowColumns) {
      panel(0, 1, bottom, top);
      continue;
    }
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
        panel(pier, left, low, high);
        pier = right;
        const il = mix(start, end, left), ir = mix(start, end, right);
        const ol = mix(wall.start, wall.end, left), or = mix(wall.start, wall.end, right);
        quad(il, low, ir, low, or, low, ol, low);
        quad(il, high, ol, high, or, high, ir, high);
        quad(il, low, ol, low, ol, high, il, high);
        quad(ir, low, ir, high, or, high, or, low);
      }
      panel(pier, 1, low, high);
    }
    panel(0, 1, bandBottom, top);
  }

  const ceilingStart = indices.length;
  // Reuse the prepared roof triangulation, including its existing courtyard cutouts.
  for (let i = 0; i < facade.indices.length; i += 3) {
    const a = facade.indices[i], b = facade.indices[i+1], c = facade.indices[i+2];
    if (facade.uvs?.[a*2] !== -2 || facade.uvs[b*2] !== -2 || facade.uvs[c*2] !== -2) continue;
    const first = positions.length / 3;
    for (const vertex of [a, c, b]) positions.push(facade.positions[vertex*3], oy + top, facade.positions[vertex*3+2]);
    indices.push(first, first+1, first+2);
  }
  return {positions, indices, ceilingStart};
}
