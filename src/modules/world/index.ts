import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { defineModule } from '../../core/context.ts';
import { objectTemplatesModule } from '../object-templates/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { worldStreamingModule, type SectionBounds } from '../world-streaming/index.ts';
import { worldGenerationModule } from '../world-generation/index.ts';
import { worldTemplates } from './templates.ts';
import { scheme, regions, insertions } from './scheme.ts';

export const worldModule = defineModule({
  id: 'world', title: 'Первый квартал', category: 'Окружение',
  requires: { generator: worldGenerationModule, templates: objectTemplatesModule, rendering: objectRenderingModule, streaming: worldStreamingModule },
  setup({ deps, scope }) {
    const generated = deps.generator.generateRegions(scheme, regions);
    for (const template of worldTemplates) deps.templates.register(template, scope);
    const buildings = new Set<ReturnType<typeof deps.rendering.createObject>>();
    const lamps: typeof buildings = new Set();
    const placements = [...generated.flatMap(region => region.objects), ...insertions];
    const buildingCount = placements.filter(p => p.templateId === 'world/building').length;
    const lampCount = placements.filter(p => p.templateId === 'world/lamp').length;
    const sections = new Map<string, { bounds: SectionBounds; placements: typeof placements }>();
    for (const placement of placements) {
      const [x, , z] = placement.position;
      const key = placement.templateId === 'world/terrain' ? placement.key : `${Math.floor(x / 128)}/${Math.floor(z / 128)}`;
      // Include full surfaces and facade overhangs, so long tiles survive near a section boundary.
      const halfX = (placement.parameters.width ?? 2) / 2 + 4;
      const halfZ = (placement.parameters.depth ?? 2) / 2 + 4;
      const bounds = { minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ };
      const section = sections.get(key);
      if (section) {
        section.bounds = { minX: Math.min(section.bounds.minX, bounds.minX), maxX: Math.max(section.bounds.maxX, bounds.maxX),
          minZ: Math.min(section.bounds.minZ, bounds.minZ), maxZ: Math.max(section.bounds.maxZ, bounds.maxZ) };
        section.placements.push(placement);
      } else sections.set(key, { bounds, placements: [placement] });
    }
    for (const [key, section] of sections) {
      deps.streaming.registerSection(`${scheme.id}/${key}`, section.bounds, owner => {
        for (const placement of section.placements) {
          const surface = placement.templateId.slice('world/'.length);
          const batchMaterial = ['road', 'sidewalk', 'curb'].includes(surface) ? surface : undefined;
          const object = deps.rendering.createObject(placement.templateId, placement.key, placement.parameters, owner, 'static', batchMaterial);
          object.root.position.copyFromFloats(...placement.position);
          object.root.rotation.copyFromFloats(...placement.rotation);
          const list = placement.templateId === 'world/building' ? buildings : placement.templateId === 'world/lamp' ? lamps : undefined;
          if (list) { list.add(object); owner.onDispose(() => list.delete(object)); }
        }
      }, scope);
    }
    return { bounds: scheme.bounds, objectCount: placements.length,
      regions: generated.map(region => ({ id: region.schemeId, bounds: region.bounds, objectCount: region.objects.length })),
      streaming: deps.streaming.getStats,
      visibility() {
        const lods = [0, 0, 0];
        let hidden = buildingCount - buildings.size;
        for (const building of buildings) {
          const level = building.level();
          if (level === null) hidden++; else lods[level]++;
        }
        const lampLods = [0, 0];
        let hiddenLamps = lampCount - lamps.size;
        for (const lamp of lamps) {
          const level = lamp.level();
          if (level === null) hiddenLamps++; else lampLods[level]++;
        }
        return { buildings: buildingCount, hidden, lods, lamps: lampCount, hiddenLamps, lampLods };
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
      let loadedSectionsMax = 0;
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
        loadedSectionsMax = Math.max(loadedSectionsMax, api.streaming().loaded);
        frames++;
      });
      scope.onDispose(() => core.scene.onAfterRenderObservable.remove(observer));
      scope.onDispose(() => {
        if (frames) {
          const { buildings, lamps } = api.visibility();
          report({ objects: api.objectCount, buildings, sampledFrames: frames, hiddenMin, hiddenMax,
            hiddenFractionMin: hiddenMin / buildings, hiddenFractionMax: hiddenMax / buildings,
            lamps, hiddenLampsMin, hiddenLampsMax, detailedLampsMax, reducedLampsMax,
            lodCandidatesMin, lodCandidatesMax, boundsUpdatesMax, batchesMax, batchedInstancesMax, loadedSectionsMax, sectionLoads: api.streaming().loads, sectionUnloads: api.streaming().unloads });
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
