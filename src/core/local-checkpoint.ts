import type { Observable } from '@babylonjs/core/Misc/observable.js';
import type { Scope } from './modules.ts';

export function trackLocalCheckpoint(onFrame: Observable<number>, scope: Scope, save: () => void) {
  let elapsed = 0;
  const frame = onFrame.add(delta => {
    elapsed += delta;
    if (elapsed < 1000) return;
    elapsed = 0;
    save();
  });
  scope.onDispose(() => onFrame.remove(frame));
  const page = globalThis.window;
  if (page) {
    const hidden = () => { if (page.document.hidden) save(); };
    page.addEventListener('pagehide', save);
    scope.onDispose(() => page.removeEventListener('pagehide', save));
    page.document.addEventListener('visibilitychange', hidden);
    scope.onDispose(() => page.document.removeEventListener('visibilitychange', hidden));
  }
  scope.onDispose(save);
}
