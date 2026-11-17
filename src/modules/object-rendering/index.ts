import { BoundingBox } from '@babylonjs/core/Culling/boundingBox.js';
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { defineModule } from '../../core/context.ts';
import type { Scope } from '../../core/modules.ts';
import { geometryModule, type GeometryModel } from '../geometry/index.ts';
import { objectTemplatesModule, type ResolvedTemplate } from '../object-templates/index.ts';
import type { Material } from '@babylonjs/core/Materials/material.js';
import { createSurfaceBatches } from './surface-batches.ts';
import { SpatialGrid } from './spatial-grid.ts';
import {LodBlend} from './lod-blend.ts';
import type {Mesh} from '@babylonjs/core/Meshes/mesh.js';

export interface DistancePoint { readonly x: number; readonly y: number; readonly z: number }
interface RenderObject {
  root: TransformNode;
  seen: number;
  sync(force?: boolean): void;
  update(point: DistancePoint | null): void;
}

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
    const transitions=new Set<(delta:number)=>void>();scope.onDispose(()=>transitions.clear());
    function createVisibility(meshes:readonly Mesh[],owner:Scope,durationMs=180){
      ensureRunning();
      if(!meshes.length||meshes.some(m=>m.getScene()!==core.scene||m.isDisposed()))throw new Error('Invalid fade meshes');
      const blend=new LodBlend(durationMs);let disposed=false;
      const apply=()=>{const coverage=blend.weights.get(0)??0;for(const mesh of meshes){mesh.setEnabled(coverage>0);deps.geometry.setMeshFade(mesh,0,coverage||1);}if(!blend.running)transitions.delete(step);};
      const step=(delta:number)=>{blend.advance(delta);apply();};
      for(const mesh of meshes)mesh.setEnabled(false);
      owner.onDispose(()=>{disposed=true;transitions.delete(step);for(const mesh of meshes)if(!mesh.isDisposed()){deps.geometry.setMeshFade(mesh,0,1);mesh.setEnabled(false);}});
      return {isVisible:()=>!stopped&&!disposed&&blend.target!==null,setVisible(visible:boolean,immediate=false){ensureRunning();if(disposed)throw new Error('Fade disposed');const next=visible?0:null;if(next===blend.target&&!immediate)return;blend.select(next,immediate);apply();if(blend.running)transitions.add(step);}};
    }
    const batches = createSurfaceBatches(deps.geometry.createModel, scope);
    const objects = new Set<RenderObject>();
    const dynamic = new Set<RenderObject>();
    const pending = new Set<RenderObject>();
    const active = new Set<RenderObject>();
    const grid = new SpatialGrid<RenderObject>();
    let frame = 0;
    let candidates = 0;
    let boundsUpdates = 0;
    let source: { read(): DistancePoint | null } | undefined;
    let stopped = false;
    scope.onDispose(() => {
      stopped = true;
      source = undefined;
      for (const object of objects) object.root.dispose();
      objects.clear();
      dynamic.clear(); pending.clear(); active.clear(); grid.clear();
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
    function createObject(templateId: string, name: string, parameters: Readonly<Record<string, number>>, owner: Scope, mobility: 'static' | 'dynamic' = 'dynamic', batchMaterial?: Material | string,transitionMs=0) {
      ensureRunning();
      if (!name.trim()) throw new Error('Нужно имя объекта');
      if (typeof batchMaterial === 'string' && !batchMaterial.trim()) throw new Error('Нужно имя пакетной поверхности');
      const template = deps.templates.resolve(templateId, parameters);
      const blend=new LodBlend(transitionMs);
      if(batchMaterial&&transitionMs>0)throw new Error('Thin batches do not support model crossfades');
      if (batchMaterial && (mobility !== 'static' || template.levels.some(level => level.parts.length !== 1 || level.parts[0].faceUV !== undefined))) throw new Error('Пакетная отрисовка требует static и одну деталь без faceUV на LOD');
      if (batchMaterial && typeof batchMaterial !== 'string' && (batchMaterial.getScene() !== core.scene || batchMaterial.needAlphaBlending())) throw new Error('Нужен материал текущей сцены без alpha blending');
      const bounds = templateBounds(template);
      const minimum = bounds.minimum.clone();
      const maximum = bounds.maximum.clone();
      const root = new TransformNode(name, core.scene);
      owner.onDispose(() => root.dispose());
      const onModelCreated = new Observable<GeometryModel>();
      root.onDisposeObservable.addOnce(() => onModelCreated.clear());
      const levelScope: Scope = { onDispose: cleanup => { root.onDisposeObservable.addOnce(cleanup); } };
      const models = new Map<number, GeometryModel>();
      let current: number | null = null;
      const applyFade=()=>{
        let lower=0;
        for(const [index,model]of [...models].sort(([a],[b])=>a-b)){
          const weight=blend.weights.get(index)??0;model.root.setEnabled(weight>0);
          for(const meshes of model.surfaces.values())for(const mesh of meshes)deps.geometry.setMeshFade(mesh,weight>0?Math.min(1,lower):0,weight>0?Math.min(1,lower+weight):1);
          lower+=weight;
        }
        if(!blend.running){transitions.delete(stepFade);if(current===null)active.delete(object);}
      };
      const stepFade=(delta:number)=>{blend.advance(delta);applyFade();};
      let batchKey: string | null = null;
      let batchDirty = true;
      let currentBatchMaterial: Material | undefined;
      let matrixFlag = -1;
      let parent = root.parent;
      const object: RenderObject = { root, seen: -1,
        sync(force = false) {
          const changed = force || parent !== root.parent || !root.isSynchronized();
          const world = root.computeWorldMatrix(changed);
          if (!changed && matrixFlag === world.updateFlag) return;
          if (batchMaterial && world.determinant() <= 0) throw new Error('Пакетная отрисовка не поддерживает вырожденный или зеркальный масштаб');
          if (!world.m.every(Number.isFinite)) throw new Error('Преобразование объекта должно быть конечным');
          bounds.reConstruct(minimum, maximum, world);
          const min = bounds.minimumWorld;
          const max = bounds.maximumWorld;
          if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) throw new Error('Границы объекта должны быть конечными');
          grid.insert(object, { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z }, template.hideDistance);
          matrixFlag = world.updateFlag;
          parent = root.parent;
          batchDirty = true;
          boundsUpdates++;
        },
        update(point: DistancePoint | null) {
          let next: number | null = null;
          if (point && root.isEnabled()) {
            const min = bounds.minimumWorld;
            const max = bounds.maximumWorld;
            const distance = Math.hypot(Math.max(min.x - point.x, 0, point.x - max.x), Math.max(min.y - point.y, 0, point.y - max.y), Math.max(min.z - point.z, 0, point.z - max.z));
            if (distance < template.hideDistance) {
              next = 0;
              while (next + 1 < template.levels.length && distance >= template.levels[next + 1].distance) next++;
            }
          }
          if (batchMaterial) {
            const material = typeof batchMaterial === 'string' ? deps.geometry.getSurfaceMaterial(batchMaterial, next ?? 0) : batchMaterial;
            if (material.needAlphaBlending()) throw new Error('Пакетная поверхность должна быть непрозрачной');
            if (next === current && !batchDirty && material === currentBatchMaterial) return;
            currentBatchMaterial = material;
            if (batchKey !== null) batches.remove(batchKey, object);
            batchKey = null;
            if (next !== null) {
              const part = template.levels[next].parts[0];
              const world = root.getWorldMatrix();
              const position = world.getTranslation();
              batchKey = `${Math.floor(position.x / 128)}/${Math.floor(position.z / 128)}/${material.uniqueId}/${next}`;
              const local = Matrix.Compose(Vector3.FromArray(part.size), Quaternion.FromEulerAngles(...(part.rotation ?? [0, 0, 0])), Vector3.FromArray(part.position ?? [0, 0, 0]));
              batches.set(batchKey, object, local.multiply(world), material);
            }
            batchDirty = false;
            current = next;
            if (next === null) active.delete(object); else active.add(object);
            return;
          }
          if(transitionMs>0&&(!point||!root.isEnabled())){blend.select(null,true);current=null;applyFade();active.delete(object);return;}
          if (next === current) return;
          if (next !== null && !models.has(next)) {
            // shortcut: visited LODs stay cached until disposal, revisit if memory profiling requires eviction.
            const model = deps.geometry.createModel(`${name}/lod-${next}`, template.levels[next].parts, levelScope, next);
            model.root.parent = root;
            model.root.setEnabled(false);
            models.set(next, model);
            try { onModelCreated.notifyObservers(model); } catch (error) { root.dispose(); throw error; }
            if (root.isDisposed()) return;
          }
          if(transitionMs>0){current=next;blend.select(next);applyFade();if(blend.running)transitions.add(stepFade);if(next!==null||blend.running)active.add(object);return;}
          if (current !== null) models.get(current)?.root.setEnabled(false);
          if (next !== null) models.get(next)?.root.setEnabled(true);
          current = next;
          if (next === null) active.delete(object); else active.add(object);
        },
      };
      objects.add(object);
      pending.add(object);
      if (mobility === 'dynamic') dynamic.add(object);
      root.onDisposeObservable.addOnce(() => {
        transitions.delete(stepFade);
        if (batchKey !== null) batches.remove(batchKey, object);
        grid.remove(object); dynamic.delete(object); pending.delete(object); active.delete(object);
        objects.delete(object); current = null; models.clear();
      });
      return { root, level: () => current, onModelCreated,
        refreshTransform() {
          ensureRunning();
          if (root.isDisposed()) throw new Error('Объект удалён');
          pending.add(object);
        },
      };
    }
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      candidates = 0; boundsUpdates = 0; frame++;
      const point = getDistanceOrigin();
      if (point) {
        for (const object of pending) object.sync(true);
        pending.clear();
        for (const object of dynamic) object.sync();
        for (const object of grid.query(point.x, point.z)) {
          object.seen = frame;
          candidates++;
          object.update(point);
        }
      }
      for (const object of active) if (object.seen !== frame) object.update(point);
      for(const transition of transitions)transition(core.scene.getEngine().getDeltaTime());
      batches.flush();
    });
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return { createObject, setDistanceSource, getDistanceOrigin,createVisibility,
      getStats() { ensureRunning(); return { objects: objects.size, cells: grid.size, candidates, boundsUpdates, dynamic: dynamic.size,transitions:transitions.size, ...batches.stats() }; },
    };
  },
});
