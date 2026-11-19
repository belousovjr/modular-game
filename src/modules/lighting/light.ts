import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from '../../core/modules.ts';

export interface LightingSettings { readonly hour: number }
export const DEFAULT_LIGHTING: LightingSettings = Object.freeze({ hour: 14 });

function smoothstep(min: number, max: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return t * t * (3 - 2 * t);
}

export const DEFAULT_DAY_SECONDS = 20 * 60;
export const MAX_CYCLE_SPEED = 128;
const DAY_MS = DEFAULT_DAY_SECONDS * 1000;

export function createLighting(scene: Scene, scope: Scope, onFrame?: Observable<number>) {
  const ambient = new HemisphericLight('lighting/ambient', Vector3.Up(), scene);
  scope.onDispose(() => ambient.dispose());
  const sun = new DirectionalLight('lighting/sun', Vector3.Down(), scene);
  scope.onDispose(() => sun.dispose());
  const changed = new Observable<void>();
  let settings = DEFAULT_LIGHTING;
  let stopped = false;
  let speed = 0;
  let elapsed = 0;
  scope.onDispose(() => { stopped = true; changed.clear(); });
  function setSettings(next: LightingSettings) {
    if (stopped) throw new Error('Освещение остановлено');
    if (!Number.isFinite(next.hour) || next.hour < 0 || next.hour >= 24) throw new Error('Время суток должно быть от 0 до 24 часов, не включая 24');
    // shortcut: fixed artistic sun path, revisit for latitude, date and seasonal daylight.
    const angle = (next.hour - 6) * Math.PI / 12;
    const height = Math.sin(angle);
    const daylight = smoothstep(-0.15, 0.2, height);
    sun.direction.set(-Math.cos(angle), -0.8 * height, -0.6 * height);
    sun.diffuse = Color3.Lerp(Color3.FromHexString('#ff9455'), Color3.FromHexString('#fff4df'), smoothstep(0.05, 0.65, height));
    sun.specular.copyFrom(sun.diffuse);
    sun.intensity = 1.05 * smoothstep(0, 0.5, height);
    ambient.intensity = 0.2 + 0.45 * daylight;
    ambient.diffuse = Color3.Lerp(Color3.FromHexString('#91a6c8'), Color3.FromHexString('#dce9ff'), daylight);
    ambient.groundColor = Color3.Lerp(Color3.FromHexString('#252c3c'), Color3.FromHexString('#605d51'), daylight);
    settings = Object.freeze({ hour: next.hour });
    changed.notifyObservers();
  }
  setSettings(DEFAULT_LIGHTING);
  function advance(delta: number, multiplier: number) {
    const cycleMs = DAY_MS / multiplier;
    setSettings({hour: (settings.hour + (delta % cycleMs) / cycleMs * 24) % 24});
  }
  if (onFrame) {
    const frame = onFrame.add(delta => {
      if (speed === 0) return;
      elapsed += delta;
      if (elapsed < Math.max(50, 250 / Math.max(1, speed))) return;
      const pending = elapsed;
      elapsed = 0;
      advance(pending, speed);
    });
    scope.onDispose(() => onFrame.remove(frame));
  }
  return {
    getSpeed: () => speed,
    setSpeed(value: number) {
      if (stopped) throw new Error('Освещение остановлено');
      if (!Number.isFinite(value) || value < 0 || value > MAX_CYCLE_SPEED) throw new RangeError(`Скорость цикла должна быть от 0 до ${MAX_CYCLE_SPEED}`);
      if (value === speed) return;
      const previous = speed, pending = elapsed;
      speed = value;
      elapsed = 0;
      if (pending > 0) advance(pending, previous);
      else changed.notifyObservers();
    },
    getSettings: () => settings,
    getSunLight() {
      if (stopped) throw new Error('Освещение остановлено');
      return sun;
    },
    setSettings,
    subscribe(listener: () => void) {
      if (stopped) throw new Error('Освещение остановлено');
      const observer = changed.add(listener);
      return () => { changed.remove(observer); };
    },
  };
}
