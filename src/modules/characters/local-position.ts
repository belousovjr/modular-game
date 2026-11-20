const KEY = 'modular-game.local-player-position';
type Position = {x:number;y:number;z:number};

export function readLocalPosition(): Position | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return;
    if ('x' in value && typeof value.x==='number' && Number.isFinite(value.x) &&
        'y' in value && typeof value.y==='number' && Number.isFinite(value.y) &&
        'z' in value && typeof value.z==='number' && Number.isFinite(value.z)) {
      return {x:value.x,y:value.y,z:value.z};
    }
  } catch { /* Saving a local position is optional. */ }
}

export function saveLocalPosition({x,y,z}: Position): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify({version:1,x,y,z}));
    return true;
  } catch { return false; }
}

export function clearLocalPosition() {
  try { localStorage.removeItem(KEY); }
  catch { /* Personal checkpoints are optional. */ }
}
