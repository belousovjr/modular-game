import { createElement } from 'react';
import { defineModule } from '../../core/context.ts';
import { createLighting } from './light.ts';
import { LightingPanel } from './panel.tsx';

export type { LightingSettings } from './light.ts';
export const lightingModule = defineModule({
  id: 'lighting', category: 'Окружение', title: 'Базовое освещение', requires: {},
  setup({ core, scope }) {
    const api = createLighting(core.scene, scope);
    scope.onDispose(core.panels.register('lighting', 'Освещение', createElement(LightingPanel, api)));
    return api;
  },
});
