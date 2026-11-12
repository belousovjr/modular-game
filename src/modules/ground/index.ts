import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { defineModule } from '../../core/context.ts';
export const groundModule = defineModule({
  id: 'ground', category: 'Окружение', title: 'Площадка', requires: {},
  setup({ core, scope }) {
    const material = new StandardMaterial('ground-material', core.scene);
    material.diffuseColor = Color3.FromHexString('#25394b');
    const mesh = MeshBuilder.CreateGround('ground', { width: 18, height: 18 }, core.scene);
    mesh.material = material;
    scope.onDispose(() => { mesh.dispose(); material.dispose(); });
    return { heightAt: (_x: number, _z: number) => 0 };
  },
  test: {
    durationSeconds: 4,
    setup({ core, api }) {
      const camera = core.scene.activeCamera;
      if (!(camera instanceof ArcRotateCamera)) throw new Error('Для обзора нужна ArcRotateCamera');
      camera.setTarget(new Vector3(0, api.heightAt(0, 0), 0));
      return progress => {
        camera.alpha = -Math.PI / 2 + progress * Math.PI * 2;
        camera.beta = 0.6 + Math.sin(progress * Math.PI) * 0.5;
        camera.radius = 15 + Math.sin(progress * Math.PI * 2) * 5;
      };
    },
  },
});
