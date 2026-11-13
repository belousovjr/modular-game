import { Vector4 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { defineModule } from '../../core/context.ts';
import type { Scope } from '../../core/modules.ts';

type Triple = readonly [number, number, number];
export type FaceUV = readonly [number, number, number, number];
export interface GeometryPart {
  readonly surface: string;
  readonly size: Triple;
  readonly position?: Triple;
  readonly rotation?: Triple;
  readonly faceUV?: readonly FaceUV[];
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
    const sources = new Map<string, Mesh>();
    function getSource(faceUV: readonly FaceUV[] | undefined): Mesh {
      if (!faceUV) return source;
      const key = JSON.stringify(faceUV);
      let variant = sources.get(key);
      if (!variant) {
        variant = MeshBuilder.CreateBox(`geometry-box-uv-${sources.size}`, { size: 1, faceUV: faceUV.map(uv => new Vector4(...uv)) }, core.scene);
        scope.onDispose(() => variant?.dispose());
        const positions = variant.getVerticesData('position');
        const uv = variant.getVerticesData('uv');
        if (!positions || !uv) throw new Error('У куба отсутствуют координаты вершин или UV');
        // Babylon flips V on opposite faces; atlas height must follow local +Y on all walls.
        for (let vertex = 0; vertex < 16; vertex++) {
          uv[vertex * 2 + 1] = faceUV[Math.floor(vertex / 4)][positions[vertex * 3 + 1] > 0 ? 1 : 3];
        }
        variant.setVerticesData('uv', uv);
        variant.isVisible = false;
        variant.material = fallback;
        sources.set(key, variant);
      }
      return variant;
    }
    const models = new Map<TransformNode, { surfaces: ReadonlyMap<string, readonly Mesh[]>; detail: number }>();
    let surfaceMaterials: ReadonlyMap<string, readonly Material[]> | undefined;
    function getSurfaceMaterial(surface: string, detail = 0): Material {
      if (stopped) throw new Error('Модуль геометрии остановлен');
      if (!Number.isSafeInteger(detail) || detail < 0) throw new Error('Некорректный уровень оформления');
      const levels = surfaceMaterials?.get(surface);
      return levels?.[Math.min(detail, levels.length - 1)] ?? fallback;
    }
    function applyMaterials(previous: ReadonlyMap<string, readonly Material[]> | undefined) {
      for (const { surfaces, detail } of models.values()) for (const [surface, meshes] of surfaces) {
        const levels = previous?.get(surface);
        const expected = levels?.[Math.min(detail, levels.length - 1)] ?? fallback;
        for (const mesh of meshes) if (mesh.material === expected) mesh.material = getSurfaceMaterial(surface, detail);
      }
    }
    function registerSurfaceMaterials(materials: ReadonlyMap<string, readonly Material[]>, owner: Scope) {
      if (stopped) throw new Error('Модуль геометрии остановлен');
      if (surfaceMaterials) throw new Error('Оформление поверхностей уже подключено');
      for (const [surface, levels] of materials) {
        if (!surface.trim() || !levels.length || levels.some(material => material.getScene() !== core.scene)) throw new Error('Некорректное оформление поверхности');
      }
      const connection = new Map(Array.from(materials, ([surface, levels]) => [surface, [...levels]]));
      surfaceMaterials = connection;
      owner.onDispose(() => { if (surfaceMaterials === connection) { surfaceMaterials = undefined; applyMaterials(connection); } });
      applyMaterials(undefined);
    }
    let stopped = false;
    scope.onDispose(() => {
      stopped = true;
      for (const model of models.keys()) model.dispose();
      models.clear();
    });

    function validateParts(parts: readonly GeometryPart[]) {
      if (stopped) throw new Error('Модуль геометрии остановлен');
      if (!parts.length) throw new Error('Нужна хотя бы одна деталь');
      for (const part of parts) {
        if (!part.surface.trim() || part.size.length !== 3 || !part.size.every(value => Number.isFinite(value) && value > 0) ||
            [part.position, part.rotation].some(value => value !== undefined && (value.length !== 3 || !value.every(Number.isFinite))) ||
            (part.faceUV !== undefined && (part.faceUV.length !== 6 || part.faceUV.some(uv => uv.length !== 4 || !uv.every(value => Number.isFinite(value) && value >= 0 && value <= 1) || uv[0] >= uv[2] || uv[1] >= uv[3])))) {
          throw new Error('Некорректная поверхность, размер или преобразование детали');
        }
      }
    }

    function createModel(name: string, parts: readonly GeometryPart[], owner: Scope, detail = 0): GeometryModel {
      validateParts(parts);
      getSurfaceMaterial(parts[0].surface, detail);
      if (!name.trim()) throw new Error('Нужно имя модели');
      const root = new TransformNode(name, core.scene);
      owner.onDispose(() => root.dispose());
      root.onDisposeObservable.addOnce(() => models.delete(root));
      const surfaces = new Map<string, Mesh[]>();
      try {
        for (const part of parts) {
          // shortcut: clones share geometry but not draw calls, batch compatible variants in object-rendering.
          const mesh = getSource(part.faceUV).clone(`${name}/${part.surface}`, root, true);
          mesh.isVisible = true;
          mesh.material = getSurfaceMaterial(part.surface, detail);
          mesh.scaling.copyFromFloats(...part.size);
          if (part.position) mesh.position.copyFromFloats(...part.position);
          if (part.rotation) mesh.rotation.copyFromFloats(...part.rotation);
          const group = surfaces.get(part.surface) ?? [];
          group.push(mesh);
          surfaces.set(part.surface, group);
        }
      } catch (error) { root.dispose(); throw error; }
      models.set(root, { surfaces, detail });
      return { root, surfaces };
    }
    return { createModel, validateParts, getSurfaceMaterial, registerSurfaceMaterials };
  },
});
