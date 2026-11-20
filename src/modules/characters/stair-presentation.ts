import type { CharacterSnapshot } from './headless.ts';

export function createStairHeight() {
  let height: number | undefined;
  let settling = false;
  return (snapshot: Pick<CharacterSnapshot,'y'|'grounded'|'mode'|'vehicleId'|'onStairs'>, deltaMs: number) => {
    const {y,grounded,mode,vehicleId,onStairs}=snapshot;
    const smooth=grounded && mode==='walk' && !vehicleId && (onStairs || settling);
    if (height===undefined || !smooth || Math.abs(height-y)>.6) {
      height=y;
      settling=false;
      return y;
    }
    const difference=Math.max(-.24,Math.min(.24,height-y));
    height=y+difference*Math.exp(-deltaMs/85);
    settling=Math.abs(height-y)>.001;
    if (!settling) height=y;
    return height;
  };
}
