import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { defineModule } from '../../core/context.ts';
import { groundModule } from '../ground/index.ts';
export const beaconModule = defineModule({
  id: 'beacon', title: 'Демонстрационный маяк', requires: { ground: groundModule },
  setup({ core, deps, scope }) {
    const mesh = MeshBuilder.CreateTorus('beacon', { diameter: 2.5, thickness: 0.2, tessellation: 64 }, core.scene);
    const material = new StandardMaterial('beacon-material', core.scene);
    material.emissiveColor = Color3.FromHexString('#60e5c0');
    material.diffuseColor = material.emissiveColor;
    mesh.material = material;
    mesh.position.y = deps.ground.heightAt(0, 0) + 2;
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      // Presentation derives from authority time, never mutates simulation.
      const time = core.snapshot().seconds;
      mesh.rotation.x = Math.PI / 3;
      mesh.rotation.y = time * 0.6;
      mesh.position.y = 2 + Math.sin(time) * 0.2;
    });
    scope.onDispose(() => { core.scene.onBeforeRenderObservable.remove(observer); mesh.dispose(); material.dispose(); });
    return {};
  },
});
