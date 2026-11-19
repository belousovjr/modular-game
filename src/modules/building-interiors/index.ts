import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { defineModule } from '../../core/context.ts';
import { SceneCamera } from '../../core/fly-camera.ts';
import { createScope } from '../../core/scope.ts';
import { geometryModule } from '../geometry/index.ts';
import { worldModule } from '../world/index.ts';
import { worldStreamingModule } from '../world-streaming/index.ts';
import { buildInterior, nearInterior } from './shell.ts';

export const buildingInteriorsModule = defineModule({
  id:'building-interiors', title:'Внутренние фасады', category:'Окружение',
  requires:{world:worldModule, geometry:geometryModule, streaming:worldStreamingModule},
  setup({core,deps,scope}) {
    const active = new Set<(point: Vector3 | undefined, opacity: number) => void>();
    for (const source of deps.world.getBuildingInteriorSources()) {
      const {id, bounds, profile} = source;
      // Streaming follows the player when present, with room for the orbit camera.
      deps.streaming.registerSection(`building-interiors/${id}`, bounds, owner => {
        let shell: ReturnType<typeof createScope> | undefined;
        let floors: Mesh | undefined;
        const update = (point: Vector3 | undefined, opacity: number) => {
          const visible = point && nearInterior(profile, point, shell ? 4 : 2);
          if (!visible) {
            shell?.dispose();
            shell = undefined;
            floors = undefined;
          } else if (!shell) {
            const resources = createScope();
            try {
              const {positions,indices,slabs} = buildInterior(source);
              const mesh = deps.geometry.createSurfaceMesh(`building-interiors/${id}`, 'interior-concrete', positions, indices, resources);
              mesh.metadata = {...mesh.metadata, buildingInterior:true, shadowCaster:false, shadowReceiver:false};
              mesh.freezeWorldMatrix();
              if (slabs.indices.length) {
                floors = deps.geometry.createSurfaceMesh(`building-interiors/${id}/floors`,
                  'interior-concrete', slabs.positions, slabs.indices, resources);
                floors.metadata = {...mesh.metadata, buildingInteriorFloors:true};
                floors.freezeWorldMatrix();
              }
              shell = resources;
            } catch (error) {
              resources.dispose();
              throw error;
            }
          }
          if (floors && floors.visibility !== opacity) floors.visibility = opacity;
        };
        active.add(update);
        owner.onDispose(() => { active.delete(update); shell?.dispose(); });
      }, scope, {load:14, unload:16});
    }
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      if (!active.size) return;
      const camera = core.scene.activeCamera;
      camera?.getViewMatrix();
      const opacity = camera instanceof SceneCamera ? .8 : 1;
      for (const update of active) update(camera?.globalPosition, opacity);
    });
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return {};
  },
});
