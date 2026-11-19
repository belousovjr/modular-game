import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { defineModule } from '../../core/context.ts';
import { createScope } from '../../core/scope.ts';
import { geometryModule } from '../geometry/index.ts';
import { worldModule } from '../world/index.ts';
import { worldStreamingModule } from '../world-streaming/index.ts';
import { buildInterior, nearInterior } from './shell.ts';

export const buildingInteriorsModule = defineModule({
  id:'building-interiors', title:'Внутренние фасады', category:'Окружение',
  requires:{world:worldModule, geometry:geometryModule, streaming:worldStreamingModule},
  setup({core,deps,scope}) {
    const active = new Set<(point?: Vector3) => void>();
    for (const source of deps.world.getBuildingInteriorSources()) {
      const {id, bounds, profile} = source;
      // Streaming follows the player when present, with room for the orbit camera.
      deps.streaming.registerSection(`building-interiors/${id}`, bounds, owner => {
        let shell: ReturnType<typeof createScope> | undefined;
        const update = (point?: Vector3) => {
          const visible = point && nearInterior(profile, point, shell ? 4 : 2);
          if (!visible) {
            shell?.dispose();
            shell = undefined;
          } else if (!shell) {
            const resources = createScope();
            try {
              const {positions,indices} = buildInterior(source);
              const mesh = deps.geometry.createSurfaceMesh(`building-interiors/${id}`, 'interior-concrete', positions, indices, resources);
              mesh.metadata = {...mesh.metadata, buildingInterior:true, shadowCaster:false, shadowReceiver:false};
              mesh.freezeWorldMatrix();
              shell = resources;
            } catch (error) {
              resources.dispose();
              throw error;
            }
          }
        };
        active.add(update);
        owner.onDispose(() => { active.delete(update); shell?.dispose(); });
      }, scope, {load:14, unload:16});
    }
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      if (!active.size) return;
      const camera = core.scene.activeCamera;
      camera?.getViewMatrix();
      for (const update of active) update(camera?.globalPosition);
    });
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return {};
  },
});
