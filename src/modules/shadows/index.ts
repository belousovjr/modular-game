import { defineModule } from '../../core/context.ts';
import { lightingModule } from '../lighting/index.ts';
import { geometryModule } from '../geometry/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { createShadows } from './resources.ts';

export const shadowsModule = defineModule({
  id: 'shadows', title: 'Солнечные тени', category: 'Рендеринг',
  requires: { lighting: lightingModule, geometry: geometryModule, rendering: objectRenderingModule },
  setup({ core, deps, scope }) {
    return createShadows(core.scene, deps.lighting.getSunLight(), deps.geometry.getMeshes, deps.rendering.getDistanceOrigin, scope);
  },
});
