import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from '../../core/modules.ts';
import type { geometryModule } from '../geometry/index.ts';
import { SurfaceScale } from './surface-scale.ts';
import { surfaces } from './palette.ts';

interface MaterialsSnapshot {
  readonly materials: number; readonly textures: number; readonly loading: number;
  readonly failed: number; readonly estimatedBytes: number; readonly errors: readonly string[];
}

export function createMaterials(scene: Scene, geometry: ReturnType<typeof geometryModule.setup>, scope: Scope) {
  const changed = new Observable<void>();
  const textures = new Map<string, { texture: Texture; state: 'loading' | 'ready' | 'failed'; size: number; users: StandardMaterial[] }>();
  const materials = new Map<string, readonly StandardMaterial[]>();
  let stopped = false;
  let snapshot: MaterialsSnapshot = { materials: 0, textures: 0, loading: 0, failed: 0, estimatedBytes: 0, errors: [] };
  function publish() {
    if (stopped) return;
    const entries = [...textures.entries()];
    snapshot = Object.freeze({
      materials: [...materials.values()].reduce((count, levels) => count + levels.length, 0), textures: textures.size,
      loading: entries.filter(([, entry]) => entry.state === 'loading').length,
      failed: entries.filter(([, entry]) => entry.state === 'failed').length,
      estimatedBytes: entries.reduce((count, [, entry]) => count + Math.ceil(entry.size ** 2 * 4 * 4 / 3), 0),
      errors: Object.freeze(entries.filter(([, entry]) => entry.state === 'failed').map(([url]) => `Не удалось загрузить ${url}. Используется цвет поверхности.`)),
    });
    changed.notifyObservers();
  }
  // Registered first, so late texture callbacks cannot touch disposed materials.
  scope.onDispose(() => { stopped = true; changed.clear(); textures.clear(); materials.clear(); });
  function useTexture(family: string, tileSize: number, material: StandardMaterial) {
    const size = tileSize;
    const url = `${import.meta.env?.BASE_URL ?? '/'}textures/city/${family}-${tileSize}.webp`;
    let entry = textures.get(url);
    if (!entry) {
      const texture = new Texture(url, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, () => {
        if (stopped) return;
        const loaded = textures.get(url);
        if (!loaded) return;
        loaded.state = 'ready';
        for (const user of loaded.users) { user.diffuseTexture = texture; user.diffuseColor = Color3.White(); }
        publish();
      }, () => {
        if (stopped) return;
        const failed = textures.get(url);
        if (failed) failed.state = 'failed';
        publish();
      });
      scope.onDispose(() => texture.dispose());
      texture.gammaSpace = true;
      texture.anisotropicFilteringLevel = 2;
      texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
      entry = { texture, state: 'loading', size, users: [] };
      textures.set(url, entry);
    }
    entry.users.push(material);
    if (entry.state === 'ready') { material.diffuseTexture = entry.texture; material.diffuseColor = Color3.White(); }
  }
  const readTexture = (family: string) => textures.get(`${import.meta.env?.BASE_URL ?? '/'}textures/city/${family}-128.webp`)?.texture;
  for (const [surface, style] of Object.entries(surfaces)) {
    const material = new StandardMaterial(`materials/${surface}`, scene);
    scope.onDispose(() => material.dispose());
    material.diffuseColor = Color3.FromHexString(style.color);
    material.specularColor = Color3.Black();
    if (surface === 'lamp-head') material.emissiveColor = material.diffuseColor.clone();
    if (style.texture) {
      new SurfaceScale(material, style.texture === 'building-shell', readTexture);
      useTexture(style.texture === 'building-shell' ? 'brick' : style.texture, 128, material);
    }
    materials.set(surface, [material]);
  }
  publish();
  geometry.registerSurfaceMaterials(materials, scope);
  // This callback runs before disposal of any material/texture, including partial startup failure.
  scope.onDispose(() => { stopped = true; changed.clear(); });
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (stopped) throw new Error('Материалы остановлены');
      const observer = changed.add(listener);
      return () => { changed.remove(observer); };
    },
  };
}
