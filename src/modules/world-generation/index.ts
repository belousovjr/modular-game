import { defineModule } from '../../core/context.ts';
import { generateWorld, generateWorldRegions, generateCity } from './headless.ts';
export type { WorldScheme, GeneratedWorld, WorldPlacement, Rectangle, Street, WorldRegion, CitySource, CityMesh } from './headless.ts';

export const worldGenerationModule = defineModule({
  id: 'world-generation', title: 'Генерация мира', category: 'Окружение', requires: {},
  setup() { return { generate: generateWorld, generateRegions: generateWorldRegions, generateCity }; },
});
