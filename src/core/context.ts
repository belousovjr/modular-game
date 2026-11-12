import type { Scene } from '@babylonjs/core/scene';
import type { Observable } from '@babylonjs/core/Misc/observable';
import type { Panels } from './panels.ts';
import { moduleFactory } from './modules.ts';
export interface CoreContext { scene: Scene; onFrame: Observable<number>; panels: Panels }
export const defineModule = moduleFactory<CoreContext>();
