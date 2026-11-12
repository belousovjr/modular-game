import { groundModule } from './modules/ground/index.ts';
import { beaconModule } from './modules/beacon/index.ts';
import { simulationModule } from './modules/simulation/index.tsx';
export const modules = [simulationModule, groundModule, beaconModule];
export const defaultModules = ['simulation', 'ground', 'beacon'];
