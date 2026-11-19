import { createElement } from 'react';
import { defineModule } from '../../core/context.ts';
import { trackLocalCheckpoint } from '../../core/local-checkpoint.ts';
import type { Scope } from '../../core/modules.ts';
import { readLocalCycle, saveLocalCycle } from './local-cycle.ts';
import { createLighting } from './light.ts';
import { LightingPanel } from './panel.tsx';

export type { LightingSettings } from './light.ts';
export const lightingModule = defineModule({
  id: 'lighting', category: 'Окружение', title: 'Базовое освещение', requires: {},
  setup({ core, scope }) {
    const api = createLighting(core.scene, scope, core.onFrame);
    const restored=readLocalCycle();
    if (restored) {
      api.setSettings(restored);
      api.setSpeed(restored.speed);
    }
    let hour=api.getSettings().hour, speed=api.getSpeed(), preview=false;
    trackLocalCheckpoint(core.onFrame,scope,()=>{
      if (preview) return;
      const nextHour=api.getSettings().hour, nextSpeed=api.getSpeed();
      if (hour===nextHour && speed===nextSpeed) return;
      if (saveLocalCycle(nextHour,nextSpeed)) { hour=nextHour; speed=nextSpeed; }
    });
    scope.onDispose(core.panels.register('lighting', 'Освещение', createElement(LightingPanel, api)));
    return {
      ...api,
      startDefaultCycle() { if (!restored) api.setSpeed(1); },
      previewCycle(owner: Scope) {
        preview=true;
        const previous=api.getSettings(), previousSpeed=api.getSpeed();
        api.setSpeed(0);
        owner.onDispose(()=>{
          api.setSettings(previous);
          api.setSpeed(previousSpeed);
          preview=false;
        });
      },
    };
  },
});
