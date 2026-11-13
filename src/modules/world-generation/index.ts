import { defineModule } from '../../core/context.ts';
import { generateWorld } from './headless.ts';
export type { WorldScheme, GeneratedWorld, WorldPlacement, Rectangle, Street } from './headless.ts';

export const worldGenerationModule = defineModule({
  id: 'world-generation', title: 'Генерация мира', category: 'Окружение', requires: {},
  setup() { return { generate: generateWorld }; },
});
