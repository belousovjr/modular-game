import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from '../../core/modules.ts';
import type { geometryModule } from '../geometry/index.ts';
import { SurfaceScale } from './surface-scale.ts';
import { surfaces } from './palette.ts';
import { WaterSurface, CityFacade } from './city-surface.ts';

interface MaterialsSnapshot {
  readonly materials: number; readonly textures: number; readonly loading: number;
  readonly failed: number; readonly estimatedBytes: number; readonly errors: readonly string[];
}

export function createMaterials(scene: Scene, geometry: ReturnType<typeof geometryModule.setup>, scope: Scope) {
  const changed = new Observable<void>();
  const textures = new Map<string, { texture: Texture; state: 'loading' | 'ready' | 'failed'; size: number; users: { material: StandardMaterial; normal: boolean }[] }>();
  const tints=new Map<StandardMaterial,Color3>();scope.onDispose(()=>tints.clear());
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
      errors: Object.freeze(entries.filter(([, entry]) => entry.state === 'failed').map(([url]) => `Не удалось загрузить ${url}. ${url.endsWith('-normal.webp') ? 'Используется гладкое освещение без рельефа.' : 'Используется цвет поверхности.'}`)),
    });
    changed.notifyObservers();
  }
  // Registered first, so late texture callbacks cannot touch disposed materials.
  scope.onDispose(() => { stopped = true; changed.clear(); textures.clear(); materials.clear(); });
  function useTexture(family: string, tileSize: number, material: StandardMaterial, normal = false) {
    const size = tileSize;
    const url = `${import.meta.env?.BASE_URL ?? '/'}textures/city/${family}${normal ? '-normal' : `-${tileSize}`}.webp`;
    let entry = textures.get(url);
    if (!entry) {
      const texture = new Texture(url, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, () => {
        if (stopped) return;
        const loaded = textures.get(url);
        if (!loaded) return;
        loaded.state = 'ready';
        for (const user of loaded.users) attach(user.material, texture, user.normal);
        publish();
      }, () => {
        if (stopped) return;
        const failed = textures.get(url);
        if (failed) failed.state = 'failed';
        publish();
      });
      scope.onDispose(() => texture.dispose());
      texture.gammaSpace = !normal;
      if (normal) texture.level = 0.35;
      texture.anisotropicFilteringLevel = 2;
      texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
      entry = { texture, state: 'loading', size, users: [] };
      textures.set(url, entry);
    }
    entry.users.push({ material, normal });
    if (entry.state === 'ready') attach(material, entry.texture, normal);
  }
  function attach(material: StandardMaterial, texture: Texture, normal: boolean) {
    if (normal) material.bumpTexture = texture;
    else { material.diffuseTexture = texture; material.diffuseColor = tints.get(material)?.clone()??Color3.White(); }
  }
  const readTexture = (family: string) => textures.get(`${import.meta.env?.BASE_URL ?? '/'}textures/city/${family.endsWith('-normal') ? family : `${family}-512`}.webp`)?.texture;
  for (const [surface, style] of Object.entries(surfaces)) {
    const material = new StandardMaterial(`materials/${surface}`, scene);
    scope.onDispose(() => material.dispose());
    material.diffuseColor = Color3.FromHexString(style.color);
    const tinted=surface.startsWith('city-')||['curb','sidewalk','water','marking','signal-body','signal-off','riverbed','facade','metal'].includes(surface);
    tints.set(material,tinted?material.diffuseColor.clone():Color3.White());
    material.specularColor = Color3.Black();
    // Polygon offset keeps paint above the road without changing physical geometry or occlusion.
    if(surface==='marking'){material.zOffset=-1;material.zOffsetUnits=-2;}
    if(surface==='bank')material.backFaceCulling=false;
    if (surface==='water') { material.alpha=.88;material.specularColor=Color3.FromHexString('#a3c2c2');material.specularPower=80;material.backFaceCulling=false;new WaterSurface(material); }
    if (surface.startsWith('city-')) new CityFacade(material);
    if (surface==='signal-red') material.emissiveColor=Color3.FromHexString('#a3200b');
    if (surface === 'lamp-head') material.emissiveColor = material.diffuseColor.clone();
    if (style.texture) {
      new SurfaceScale(material, style.texture === 'building-shell', readTexture,surface.startsWith('city-'));
      const family = style.texture === 'building-shell' ? 'brick' : style.texture;
      useTexture(family, 512, material);
      useTexture(family, 512, material, true);
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
