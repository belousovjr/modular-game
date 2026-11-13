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

export function createLighting(scene: Scene, scope: Scope) {
  const ambient = new HemisphericLight('lighting/ambient', Vector3.Up(), scene);
  scope.onDispose(() => ambient.dispose());
  const sun = new DirectionalLight('lighting/sun', Vector3.Down(), scene);
  scope.onDispose(() => sun.dispose());
  const changed = new Observable<void>();
  let settings = DEFAULT_LIGHTING;
  let stopped = false;
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
    ambient.intensity = 0.04 + 0.46 * daylight;
    ambient.diffuse = Color3.Lerp(Color3.FromHexString('#6077aa'), Color3.FromHexString('#dce9ff'), daylight);
    ambient.groundColor = Color3.Lerp(Color3.FromHexString('#101420'), Color3.FromHexString('#605d51'), daylight);
    settings = Object.freeze({ hour: next.hour });
    changed.notifyObservers();
  }
  setSettings(DEFAULT_LIGHTING);
  return {
    getSettings: () => settings,
    setSettings,
    subscribe(listener: () => void) {
      if (stopped) throw new Error('Освещение остановлено');
      const observer = changed.add(listener);
      return () => { changed.remove(observer); };
    },
  };
}
