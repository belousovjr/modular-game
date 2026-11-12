import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { defineModule } from '../../core/context.ts';
export const groundModule = defineModule({
  id: 'ground', title: 'Площадка', requires: {},
  setup({ core, scope }) {
    const material = new StandardMaterial('ground-material', core.scene);
    material.diffuseColor = Color3.FromHexString('#25394b');
    const mesh = MeshBuilder.CreateGround('ground', { width: 18, height: 18 }, core.scene);
    mesh.material = material;
    scope.onDispose(() => { mesh.dispose(); material.dispose(); });
    return { heightAt: (_x: number, _z: number) => 0 };
  },
});
