import { MAX_CYCLE_SPEED } from './light.ts';

const KEY = 'modular-game.lighting-cycle';
type Cycle = {hour:number;speed:number};

export function readLocalCycle(): Cycle | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return;
    if ('hour' in value && typeof value.hour==='number' && Number.isFinite(value.hour) && value.hour>=0 && value.hour<24 &&
        'speed' in value && typeof value.speed==='number' && Number.isFinite(value.speed) && value.speed>=0 && value.speed<=MAX_CYCLE_SPEED) {
      return {hour:value.hour,speed:value.speed};
    }
  } catch { /* Saving local lighting is optional. */ }
}

export function saveLocalCycle(hour: number, speed: number): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({version:1,hour,speed}));
    return true;
  } catch { return false; }
}
