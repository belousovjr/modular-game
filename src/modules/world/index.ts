import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { defineModule } from '../../core/context.ts';
import { objectTemplatesModule } from '../object-templates/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { worldGenerationModule } from '../world-generation/index.ts';
import { worldTemplates } from './templates.ts';
import { scheme, insertions } from './scheme.ts';

export const worldModule = defineModule({
  id: 'world', title: 'Первый квартал', category: 'Окружение',
  requires: { generator: worldGenerationModule, templates: objectTemplatesModule, rendering: objectRenderingModule },
  setup({ deps, scope }) {
    const generated = deps.generator.generate(scheme);
    for (const template of worldTemplates) deps.templates.register(template, scope);
    const buildings: ReturnType<typeof deps.rendering.createObject>[] = [];
    const lamps: typeof buildings = [];
    for (const placement of [...generated.objects, ...insertions]) {
      const surface = placement.templateId.slice('world/'.length);
      const batchMaterial = ['road', 'sidewalk', 'curb'].includes(surface) ? surface : undefined;
      const object = deps.rendering.createObject(placement.templateId, placement.key, placement.parameters, scope, 'static', batchMaterial);
      object.root.position.copyFromFloats(...placement.position);
      object.root.rotation.copyFromFloats(...placement.rotation);
      if (placement.templateId === 'world/building') buildings.push(object);
      if (placement.templateId === 'world/lamp') lamps.push(object);

    }
    return { bounds: generated.bounds, objectCount: generated.objects.length + insertions.length,
      visibility() {
        const lods = [0, 0, 0];
        let hidden = 0;
        for (const building of buildings) {
          const level = building.level();
          if (level === null) hidden++; else lods[level]++;
        }
        const lampLods = [0, 0];
        let hiddenLamps = 0;
        for (const lamp of lamps) {
          const level = lamp.level();
          if (level === null) hiddenLamps++; else lampLods[level]++;
        }
        return { buildings: buildings.length, hidden, lods, lamps: lamps.length, hiddenLamps, lampLods };
      },
    };
  },
  test: {
    durationSeconds: 10,
    setup({ core, deps, api, scope, report }) {
      const camera = core.scene.activeCamera;
      if (!(camera instanceof ArcRotateCamera)) throw new Error('Для обзора квартала нужна ArcRotateCamera');
      const upperRadius = camera.upperRadiusLimit;
      scope.onDispose(() => { camera.upperRadiusLimit = upperRadius; });
      camera.upperRadiusLimit = 120;
      camera.setTarget(new Vector3((api.bounds.minX + api.bounds.maxX) / 2, 3, (api.bounds.minZ + api.bounds.maxZ) / 2));
      let frames = 0;
      let hiddenMin = Infinity;
      let hiddenMax = 0;
      let hiddenLampsMin = Infinity;
      let hiddenLampsMax = 0;
      let detailedLampsMax = 0;
      let reducedLampsMax = 0;
      let lodCandidatesMin = Infinity;
      let lodCandidatesMax = 0;
      let boundsUpdatesMax = 0;
      let batchesMax = 0;
      let batchedInstancesMax = 0;
      const observer = core.scene.onAfterRenderObservable.add(() => {
        const visibility = api.visibility();
        hiddenMin = Math.min(hiddenMin, visibility.hidden);
        hiddenMax = Math.max(hiddenMax, visibility.hidden);
        hiddenLampsMin = Math.min(hiddenLampsMin, visibility.hiddenLamps);
        hiddenLampsMax = Math.max(hiddenLampsMax, visibility.hiddenLamps);
        detailedLampsMax = Math.max(detailedLampsMax, visibility.lampLods[0]);
        reducedLampsMax = Math.max(reducedLampsMax, visibility.lampLods[1]);
        const stats = deps.rendering.getStats();
        lodCandidatesMin = Math.min(lodCandidatesMin, stats.candidates);
        lodCandidatesMax = Math.max(lodCandidatesMax, stats.candidates);
        boundsUpdatesMax = Math.max(boundsUpdatesMax, stats.boundsUpdates);
        batchesMax = Math.max(batchesMax, stats.batches);
        batchedInstancesMax = Math.max(batchedInstancesMax, stats.batchedInstances);
        frames++;
      });
      scope.onDispose(() => core.scene.onAfterRenderObservable.remove(observer));
      scope.onDispose(() => {
        if (frames) {
          const { buildings, lamps } = api.visibility();
          report({ objects: api.objectCount, buildings, sampledFrames: frames, hiddenMin, hiddenMax,
            hiddenFractionMin: hiddenMin / buildings, hiddenFractionMax: hiddenMax / buildings,
            lamps, hiddenLampsMin, hiddenLampsMax, detailedLampsMax, reducedLampsMax,
            lodCandidatesMin, lodCandidatesMax, boundsUpdatesMax, batchesMax, batchedInstancesMax });
        }
      });
      return progress => {
        camera.alpha = -Math.PI / 2 + progress * Math.PI * 2;
        camera.beta = 0.85 + Math.sin(progress * Math.PI * 2) * 0.2;
        camera.radius = 35 + (Math.sin(progress * Math.PI * 2) + 1) * 22;
      };
    },
  },
});
