import type {CityMesh} from '../world-generation/index.ts';
import {DOOR_FRAME_TRIM} from './headless.ts';
export {DOOR_FRAME_TRIM} from './headless.ts';

export function facadeDoorWindows({positions:p, indices, uvs}: CityMesh, panels: readonly (readonly number[])[]) {
  if (!uvs || !panels.length) return;
  let rectangles: Float32Array | undefined;
  for (let i = 0; i < indices.length; i += 3) {
    const [a,b,c] = [indices[i], indices[i+1], indices[i+2]];
    // Fitted facade walls are quads ordered bottom/top/top/bottom.
    if (b !== a+1 || c !== a+2 || indices[i+5] !== a+3 || uvs[a*2] < 0) continue;
    const x = p[a*3], y = p[a*3+1], z = p[a*3+2];
    const dx = p[c*3]-x, dz = p[c*3+2]-z;
    const span = Math.hypot(dx,dz), height = p[b*3+1]-y;
    if (span <= 0 || height <= 0) continue;
    const tx = dx/span, tz = dz/span;
    const u = uvs[a*2], v = uvs[a*2+1];
    const du = (uvs[c*2]-u)/span, dv = (uvs[b*2+1]-v)/height;
    if (du <= 0 || dv <= 0) continue;
    for (const panel of panels) {
      const doorDx = panel[9]-panel[0], doorDz = panel[11]-panel[2];
      const width = Math.hypot(doorDx,doorDz);
      if (doorDx*tx+doorDz*tz < .999*width) continue;
      const px = panel[0]-x, pz = panel[2]-z;
      const left = px*tx+pz*tz-DOOR_FRAME_TRIM;
      const right = left+width+2*DOOR_FRAME_TRIM;
      const bottom = panel[1]-y, top = panel[4]-y+DOOR_FRAME_TRIM;
      if (Math.abs(px*tz-pz*tx) > .95 || right <= 0 || left >= span || top <= 0 || bottom >= height) continue;
      rectangles ??= new Float32Array(p.length/3*4);
      const rect = [u+left*du, v+bottom*dv, u+right*du, v+top*dv];
      for (let vertex = a; vertex < a+4; vertex++) rectangles.set(rect, vertex*4);
      break;
    }
  }
  return rectangles;
}
