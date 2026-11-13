import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { defineModule } from '../../core/context.ts';
import { objectTemplatesModule } from '../object-templates/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { worldGenerationModule } from '../world-generation/index.ts';
import { worldTemplates } from './templates.ts';
import { scheme, insertions } from './scheme.ts';

export const worldModule = defineModule({
  id: 'world', title: 'Первый квартал', category: 'Окружение',
  requires: { generator: worldGenerationModule, templates: objectTemplatesModule, rendering: objectRenderingModule },
  setup({ core, deps, scope }) {
    const generated = deps.generator.generate(scheme);
    for (const template of worldTemplates) deps.templates.register(template, scope);
    // shortcut: local debug colors, replace with the materials module when surface styling is implemented.
    const materials = new Map<string, StandardMaterial>();
    for (const [surface, hex] of Object.entries({
      terrain: '#364d3b', road: '#343b44', sidewalk: '#a8aba4', curb: '#d6d4c6',
      walls: '#ad8d72', roof: '#575d63', foundation: '#777b81', facade: '#677b86', metal: '#394452', 'lamp-head': '#f8e4a5',
    })) {
      const material = new StandardMaterial(`world-${surface}`, core.scene);
      scope.onDispose(() => material.dispose());
      material.diffuseColor = Color3.FromHexString(hex);
      material.emissiveColor = material.diffuseColor.scale(surface === 'lamp-head' ? 1 : 0.3);
      materials.set(surface, material);
    }
    const buildings: ReturnType<typeof deps.rendering.createObject>[] = [];
    const lamps: typeof buildings = [];
    for (const placement of [...generated.objects, ...insertions]) {
      const object = deps.rendering.createObject(placement.templateId, placement.key, placement.parameters, scope, 'static');
      object.root.position.copyFromFloats(...placement.position);
      object.root.rotation.copyFromFloats(...placement.rotation);
      if (placement.templateId === 'world/building') buildings.push(object);
      if (placement.templateId === 'world/lamp') lamps.push(object);
      const observer = object.onModelCreated.add(model => {
        for (const [surface, meshes] of model.surfaces) {
          const material = materials.get(surface);
          if (material) for (const mesh of meshes) mesh.material = material;
        }
      });
      scope.onDispose(() => object.onModelCreated.remove(observer));
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
        frames++;
      });
      scope.onDispose(() => core.scene.onAfterRenderObservable.remove(observer));
      scope.onDispose(() => {
        if (frames) {
          const { buildings, lamps } = api.visibility();
          report({ objects: api.objectCount, buildings, sampledFrames: frames, hiddenMin, hiddenMax,
            hiddenFractionMin: hiddenMin / buildings, hiddenFractionMax: hiddenMax / buildings,
            lamps, hiddenLampsMin, hiddenLampsMax, detailedLampsMax, reducedLampsMax,
            lodCandidatesMin, lodCandidatesMax, boundsUpdatesMax });
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
