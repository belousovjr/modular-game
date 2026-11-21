import type { Scene } from '@babylonjs/core/scene';
import type { Observable } from '@babylonjs/core/Misc/observable';
import type { Panels } from './panels.ts';
import { moduleFactory } from './modules.ts';
export interface PlaySession {
  characterId: string;
  accessToken(): Promise<string>;
  status(message: string, inRoom: boolean): void;
}
export interface CoreContext { scene: Scene; onFrame: Observable<number>; onResetView?: Observable<void>; panels: Panels; play?: PlaySession }
export const defineModule = moduleFactory<CoreContext>();
