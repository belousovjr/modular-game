import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { defineModule } from '../../core/context.ts';

export const lightingModule = defineModule({
  id: 'lighting', category: 'Окружение', title: 'Демонстрационное освещение', requires: {},
  setup({ core, scope }) {
    const light = new HemisphericLight('light', new Vector3(0, 1, 0), core.scene);
    scope.onDispose(() => light.dispose());
    return {};
  },
});
