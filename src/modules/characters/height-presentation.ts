import type { CharacterSnapshot } from './headless.ts';

export function createDisplayHeight() {
  let height: number | undefined;
  let wasOnFoot = false;
  return (snapshot: Pick<CharacterSnapshot,'y'|'grounded'|'mode'|'vehicleAnimation'>, deltaMs: number, reset=false) => {
    const {y,grounded,mode,vehicleAnimation}=snapshot;
    const onFoot=grounded && mode==='walk' && (!vehicleAnimation || vehicleAnimation==='approaching');
    if (reset || height===undefined || !wasOnFoot || !onFoot || Math.abs(height-y)>.6) {
      height=y;
    } else {
      const difference=Math.max(-.24,Math.min(.24,height-y));
      const offset=difference*Math.exp(-deltaMs/85);
      height=Math.abs(offset)>.001 ? y+offset : y;
    }
    wasOnFoot=onFoot;
    return height;
  };
}
