import { groundModule } from './modules/ground/index.ts';
import { beaconModule } from './modules/beacon/index.ts';
import { simulationModule } from './modules/simulation/index.tsx';
import { lightingModule } from './modules/lighting/index.ts';
export const modules = [simulationModule, lightingModule, groundModule, beaconModule];
export const defaultModules = ['simulation', 'lighting', 'ground', 'beacon'];
