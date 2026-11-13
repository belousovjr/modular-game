import { createElement } from 'react';
import { defineModule } from '../../core/context.ts';
import { geometryModule } from '../geometry/index.ts';
import { createMaterials } from './resources.ts';
import { MaterialsPanel } from './panel.tsx';

export const materialsModule = defineModule({
  id: 'materials', title: 'Материалы и текстуры', category: 'Рендеринг', requires: { geometry: geometryModule },
  setup({ core, deps, scope }) {
    const api = createMaterials(core.scene, deps.geometry, scope);
    scope.onDispose(core.panels.register('materials', 'Материалы и текстуры', createElement(MaterialsPanel, api)));
    return api;
  },
});
