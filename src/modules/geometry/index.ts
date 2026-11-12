import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { defineModule } from '../../core/context.ts';
import type { Scope } from '../../core/modules.ts';

type Triple = readonly [number, number, number];
export interface GeometryPart {
  readonly surface: string;
  readonly size: Triple;
  readonly position?: Triple;
  readonly rotation?: Triple;
}
export interface GeometryModel {
  readonly root: TransformNode;
  readonly surfaces: ReadonlyMap<string, readonly Mesh[]>;
}

export const geometryModule = defineModule({
  id: 'geometry', category: 'Рендеринг', title: 'Геометрия', requires: {},
  setup({ core, scope }) {
    const fallback = new StandardMaterial('geometry-fallback', core.scene);
    scope.onDispose(() => fallback.dispose());
    fallback.disableLighting = true;
    fallback.emissiveColor = Color3.FromHexString('#8899aa');
    const source = MeshBuilder.CreateBox('geometry-box-source', { size: 1 }, core.scene);
    scope.onDispose(() => source.dispose());
    source.isVisible = false;
    source.material = fallback;
    const models = new Set<TransformNode>();
    let stopped = false;
    scope.onDispose(() => {
      stopped = true;
      for (const model of models) model.dispose();
      models.clear();
    });

    function createModel(name: string, parts: readonly GeometryPart[], owner: Scope): GeometryModel {
      if (stopped) throw new Error('Модуль геометрии остановлен');
      if (!name.trim() || !parts.length) throw new Error('Нужны имя модели и хотя бы одна деталь');
      for (const part of parts) {
        if (!part.surface.trim() || part.size.length !== 3 || !part.size.every(value => Number.isFinite(value) && value > 0) ||
            [part.position, part.rotation].some(value => value !== undefined && (value.length !== 3 || !value.every(Number.isFinite)))) {
          throw new Error('Некорректная поверхность, размер или преобразование детали');
        }
      }
      const root = new TransformNode(name, core.scene);
      owner.onDispose(() => root.dispose());
      models.add(root);
      root.onDisposeObservable.addOnce(() => models.delete(root));
      const surfaces = new Map<string, Mesh[]>();
      try {
        for (const part of parts) {
          // shortcut: clones share geometry but not draw calls, batch compatible variants in object-rendering.
          const mesh = source.clone(`${name}/${part.surface}`, root, true);
          mesh.isVisible = true;
          mesh.scaling.copyFromFloats(...part.size);
          if (part.position) mesh.position.copyFromFloats(...part.position);
          if (part.rotation) mesh.rotation.copyFromFloats(...part.rotation);
          const group = surfaces.get(part.surface) ?? [];
          group.push(mesh);
          surfaces.set(part.surface, group);
        }
      } catch (error) { root.dispose(); throw error; }
      return { root, surfaces };
    }
    return { createModel };
  },
  test: {
    durationSeconds: 4,
    setup({ core, api, scope }) {
      const camera = core.scene.activeCamera;
      if (!(camera instanceof ArcRotateCamera)) throw new Error('Для обзора нужна ArcRotateCamera');
      for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
          const model = api.createModel(`geometry-test-${x}-${z}`, [
            { surface: 'walls', size: [1.5, 2, 1.5], position: [0, 1, 0] },
            { surface: 'roof', size: [1.8, 0.2, 1.8], position: [0, 2.1, 0] },
          ], scope);
          model.root.position.set(x * 3, 0, z * 3);
        }
      }
      camera.setTarget(new Vector3(0, 1, 0));
      return progress => {
        camera.alpha = -Math.PI / 2 + progress * Math.PI * 2;
        camera.beta = 0.9;
        camera.radius = 23;
      };
    },
  },
});
