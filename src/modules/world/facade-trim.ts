import type {CityMesh} from '../world-generation/index.ts';

const BELT_THICKNESS = .25;
const CROWN_INSET = .1875; // Top of coarse shell above the window grid, in prepare-downtown.py.

export function collectFacadeBelts(details: readonly {meshes:readonly CityMesh[]}[]) {
  const belts: {surface:string; x:number; z:number; dx:number; dz:number; length:number; height:number}[] = [];
  for (const detail of details) for (const {surface, positions:p, indices, uvs} of detail.meshes) {
    if (!uvs || !surface.startsWith('city-') || !surface.endsWith('-detail')) continue;
    for (let i = 0; i < indices.length; i += 3) {
      const [a,b,c] = [indices[i], indices[i + 1], indices[i + 2]];
      if (uvs[a * 2] !== -3 || Math.abs(p[b * 3 + 1] - p[a * 3 + 1] - BELT_THICKNESS) > .0001 || p[c * 3 + 1] !== p[b * 3 + 1]) continue;
      const x = p[a * 3], z = p[a * 3 + 2], dx = p[c * 3] - x, dz = p[c * 3 + 2] - z;
      const length = Math.hypot(dx, dz);
      if (length >= .5) belts.push({surface:surface.slice(0,-7), x, z, dx:dx/length, dz:dz/length, length, height:p[a * 3 + 1]+BELT_THICKNESS/2});
    }
  }
  return belts;
}

export function facadeTrim({surface, positions:p, indices, uvs}: CityMesh, belts: ReturnType<typeof collectFacadeBelts>) {
  const trim = new Float32Array(p.length / 3 * 4);
  if (!uvs) return trim;
  const candidates = belts.filter(belt => surface.startsWith(belt.surface+'-'));
  for (let i = 0; i < indices.length; i += 3) {
    const [a,b,c] = [indices[i], indices[i + 1], indices[i + 2]];
    // Prepared walls are independent quads in bottom/top/top/bottom order. Caps have negative U.
    if (b !== a+1 || c !== a+2 || indices[i + 5] !== a+3 || uvs[a*2] < 0) continue;
    const low = p[a*3+1], high = p[b*3+1], bottomV = uvs[a*2+1], topV = uvs[b*2+1];
    const storey = (high-low)/(topV-bottomV);
    if (!(storey > 0)) continue;
    const rows = Math.round(topV-CROWN_INSET/storey);
    const x = p[a*3], z = p[a*3+2], spanX = p[c*3]-x, spanZ = p[c*3+2]-z, length = Math.hypot(spanX,spanZ);
    if (length === 0) continue;
    const tx = spanX/length, tz = spanZ/length;
    let start = 0, end = 0;
    // shortcut: unaligned simplified edges keep only the plinth and crown; revisit with authored trim UVs.
    for (const belt of candidates) {
      const beltV = bottomV+(belt.height-low)/storey;
      if (Math.abs(beltV-1) > .001 || belt.dx*tx+belt.dz*tz < .999) continue;
      const bx = belt.x-x, bz = belt.z-z;
      const along = bx*tx+bz*tz;
      if (Math.abs(bx*tz-bz*tx) > .2 || along > length || along+belt.length < 0) continue;
      const u = uvs[a*2], scale = (uvs[c*2]-u)/length;
      start = u+along*scale;
      end = u+(along+belt.length)*scale;
      break;
    }
    for (let vertex = a; vertex < a+4; vertex++) {
      const offset = vertex*4;
      trim[offset] = rows;
      trim[offset+1] = storey;
      trim[offset+2] = start;
      trim[offset+3] = end;
    }
  }
  return trim;
}
