export const CAMERA_STORAGE_KEY = 'modular-game.camera';
interface Point { x: number; y: number; z: number }
export interface CameraSettings { position: Point; rotation: Point }
export const DEFAULT_CAMERA_SETTINGS: CameraSettings = {
  position: { x: 0, y: 1 + 12 * Math.cos(1.05), z: -12 * Math.sin(1.05) },
  rotation: { x: Math.PI / 2 - 1.05, y: 0, z: 0 },
};
function point(value: unknown): value is Point {
  return !!value && typeof value === 'object' &&
    'x' in value && typeof value.x === 'number' && Number.isFinite(value.x) &&
    'y' in value && typeof value.y === 'number' && Number.isFinite(value.y) &&
    'z' in value && typeof value.z === 'number' && Number.isFinite(value.z);
}
export function readCamera(): CameraSettings | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CAMERA_STORAGE_KEY) ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value)) return;
    if (value.version === 2) {
      if (!('position' in value) || !point(value.position) || !('rotation' in value) || !point(value.rotation) || Math.abs(value.rotation.x) >= Math.PI / 2) return;
      return { position: { ...value.position }, rotation: { ...value.rotation } };
    }
    if (value.version !== 1 ||
        !('alpha' in value) || typeof value.alpha !== 'number' || !Number.isFinite(value.alpha) ||
        !('beta' in value) || typeof value.beta !== 'number' || !Number.isFinite(value.beta) || value.beta <= 0 || value.beta >= Math.PI ||
        !('radius' in value) || typeof value.radius !== 'number' || !Number.isFinite(value.radius) || value.radius < 3 || value.radius > 15000 ||
        !('target' in value) || !point(value.target)) return;
    const migrated = {
      position: {
        x: value.target.x + value.radius * Math.cos(value.alpha) * Math.sin(value.beta),
        y: value.target.y + value.radius * Math.cos(value.beta),
        z: value.target.z + value.radius * Math.sin(value.alpha) * Math.sin(value.beta),
      },
      rotation: { x: Math.PI / 2 - value.beta, y: -value.alpha - Math.PI / 2, z: 0 },
    };
    if (!point(migrated.position)) return;
    writeCamera(migrated);
    return migrated;
  } catch { /* Personal camera settings are optional. */ }
}
export function writeCamera(value: CameraSettings) {
  try { localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({ version: 2, ...value })); }
  catch { /* Keep the camera working when storage is unavailable. */ }
}
