import type { Scene } from '@babylonjs/core/scene';
import type { Snapshot } from '../simulation/authority.ts';
import { moduleFactory } from './modules.ts';
export interface CoreContext { scene: Scene; snapshot(): Snapshot }
export const defineModule = moduleFactory<CoreContext>();
