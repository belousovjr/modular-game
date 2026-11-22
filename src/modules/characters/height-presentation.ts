import { FALL_ACCELERATION, type CharacterSnapshot } from './headless.ts';

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

const MAX_HEIGHT_LEAD_MS = 50;

export function createOnlineJumpHeight() {
  let height: number | undefined;
  let tick = -1;
  let age = 0;
  let inJump = false;
  return (state: Pick<CharacterSnapshot,'tick'|'grounded'|'verticalSpeed'|'mode'|'y'>,
    base: number, deltaMs: number, reset: boolean) => {
    if (reset || height === undefined || state.mode !== 'walk') {
      height = base;
      tick = state.tick;
      age = 0;
      inJump = false;
      return height;
    }

    age = state.tick === tick ? age + deltaMs : 0;
    tick = state.tick;
    if (!state.grounded) {
      inJump = true;
      const lead = Math.min(age,MAX_HEIGHT_LEAD_MS) / 1000;
      const target = state.y + lead*(state.verticalSpeed-FALL_ACCELERATION*lead/2);
      const delta = Math.min(deltaMs,MAX_HEIGHT_LEAD_MS) / 1000;
      const speed = age<=MAX_HEIGHT_LEAD_MS ? state.verticalSpeed-FALL_ACCELERATION*lead : 0;
      height += speed*delta;
      height += (target-height)*(1-Math.exp(-deltaMs/55));
    } else if (inJump) {
      height += (base-height)*(1-Math.exp(-deltaMs/45));
      if (Math.abs(base-height)<.005) inJump=false;
    }
    if (!inJump) height=base;
    return height;
  };
}
