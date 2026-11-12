export const CAMERA_STORAGE_KEY = 'modular-game.camera';
export interface CameraSettings {
  alpha: number; beta: number; radius: number;
  target: { x: number; y: number; z: number };
}
export function readCamera(): CameraSettings | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CAMERA_STORAGE_KEY) ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
        !('alpha' in value) || typeof value.alpha !== 'number' || !Number.isFinite(value.alpha) ||
        !('beta' in value) || typeof value.beta !== 'number' || !Number.isFinite(value.beta) || value.beta <= 0 || value.beta >= Math.PI ||
        !('radius' in value) || typeof value.radius !== 'number' || !Number.isFinite(value.radius) || value.radius < 3 || value.radius > 35 ||
        !('target' in value) || !value.target || typeof value.target !== 'object') return;
    const target = value.target;
    if (!('x' in target) || typeof target.x !== 'number' || !Number.isFinite(target.x) ||
        !('y' in target) || typeof target.y !== 'number' || !Number.isFinite(target.y) ||
        !('z' in target) || typeof target.z !== 'number' || !Number.isFinite(target.z)) return;
    return { alpha: value.alpha, beta: value.beta, radius: value.radius, target: { x: target.x, y: target.y, z: target.z } };
  } catch { /* Personal camera settings are optional. */ }
}
export function writeCamera(value: CameraSettings) {
  try { localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({ version: 1, ...value })); }
  catch { /* Keep the camera working when storage is unavailable. */ }
}
