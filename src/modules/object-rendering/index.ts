import { BoundingBox } from '@babylonjs/core/Culling/boundingBox.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { defineModule } from '../../core/context.ts';
import type { Scope } from '../../core/modules.ts';
import { geometryModule, type GeometryModel } from '../geometry/index.ts';
import { objectTemplatesModule, type ResolvedTemplate } from '../object-templates/index.ts';

export interface DistancePoint { readonly x: number; readonly y: number; readonly z: number }

function templateBounds(template: ResolvedTemplate) {
  const minimum = new Vector3(Infinity, Infinity, Infinity);
  const maximum = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const level of template.levels) {
    for (const part of level.parts) {
      const matrix = Matrix.Compose(Vector3.FromArray(part.size), Quaternion.FromEulerAngles(...(part.rotation ?? [0, 0, 0])), Vector3.FromArray(part.position ?? [0, 0, 0]));
      const box = new BoundingBox(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5), matrix);
      minimum.minimizeInPlace(box.minimumWorld);
      maximum.maximizeInPlace(box.maximumWorld);
    }
  }
  if (![minimum.x, minimum.y, minimum.z, maximum.x, maximum.y, maximum.z].every(Number.isFinite)) throw new Error('Границы шаблона должны быть конечными');
  return new BoundingBox(minimum, maximum);
}

export const objectRenderingModule = defineModule({
  id: 'object-rendering', title: 'Отрисовка объектов', category: 'Рендеринг',
  requires: { geometry: geometryModule, templates: objectTemplatesModule },
  setup({ core, deps, scope }) {
    const objects = new Set<{ root: TransformNode; update(point: DistancePoint | null): void }>();
    let source: { read(): DistancePoint | null } | undefined;
    let stopped = false;
    scope.onDispose(() => {
      stopped = true;
      source = undefined;
      for (const object of objects) object.root.dispose();
      objects.clear();
    });
    function ensureRunning() {
      if (stopped) throw new Error('Модуль отрисовки остановлен');
    }
    function getDistanceOrigin(): DistancePoint | null {
      ensureRunning();
      let point: DistancePoint | null;
      if (source) point = source.read();
      else {
        const camera = core.scene.activeCamera;
        camera?.getViewMatrix(true);
        point = camera?.globalPosition ?? null;
      }
      if (point === null) return null;
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('Точка отсчёта должна иметь конечные координаты');
      return { x: point.x, y: point.y, z: point.z };
    }
    function setDistanceSource(read: () => DistancePoint | null, owner: Scope) {
      ensureRunning();
      if (source) throw new Error('Источник расстояний уже подключён');
      const connection = { read };
      source = connection;
      owner.onDispose(() => { if (source === connection) source = undefined; });
    }
    function createObject(templateId: string, name: string, parameters: Readonly<Record<string, number>>, owner: Scope) {
      ensureRunning();
      if (!name.trim()) throw new Error('Нужно имя объекта');
      const template = deps.templates.resolve(templateId, parameters);
      const bounds = templateBounds(template);
      const minimum = bounds.minimum.clone();
      const maximum = bounds.maximum.clone();
      const root = new TransformNode(name, core.scene);
      owner.onDispose(() => root.dispose());
      const levelScope: Scope = { onDispose: cleanup => { root.onDisposeObservable.addOnce(cleanup); } };
      const models = new Map<number, GeometryModel>();
      let current: number | null = null;
      const object = { root, update(point: DistancePoint | null) {
        let next: number | null = null;
        if (point) {
          const world = root.computeWorldMatrix(true);
          if (!world.m.every(Number.isFinite)) throw new Error('Преобразование объекта должно быть конечным');
          bounds.reConstruct(minimum, maximum, world);
          const min = bounds.minimumWorld;
          const max = bounds.maximumWorld;
          const distance = Math.hypot(Math.max(min.x - point.x, 0, point.x - max.x), Math.max(min.y - point.y, 0, point.y - max.y), Math.max(min.z - point.z, 0, point.z - max.z));
          if (distance < template.hideDistance) {
            next = 0;
            while (next + 1 < template.levels.length && distance >= template.levels[next + 1].distance) next++;
          }
        }
        if (next === current) return;
        if (next !== null && !models.has(next)) {
          // shortcut: visited LODs stay cached until disposal, revisit if memory profiling requires eviction.
          const model = deps.geometry.createModel(`${name}/lod-${next}`, template.levels[next].parts, levelScope);
          model.root.parent = root;
          model.root.setEnabled(false);
          models.set(next, model);
        }
        if (current !== null) models.get(current)?.root.setEnabled(false);
        if (next !== null) models.get(next)?.root.setEnabled(true);
        current = next;
      } };
      objects.add(object);
      root.onDisposeObservable.addOnce(() => { objects.delete(object); current = null; models.clear(); });
      return { root, level: () => current };
    }
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      if (!objects.size) return;
      const point = getDistanceOrigin();
      for (const object of objects) object.update(point);
    });
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return { createObject, setDistanceSource, getDistanceOrigin };
  },
});
