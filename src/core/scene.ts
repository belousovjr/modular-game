import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { createLocalAuthority, type Snapshot } from '../simulation/authority.ts';
import { startModules, type ModuleDefinition } from './modules.ts';
import type { CoreContext } from './context.ts';
export function createViewport(canvas: HTMLCanvasElement, report: (snapshot: Snapshot) => void) {
  const engine = new Engine(canvas, true);
  let session: { scene: Scene; dispose(): void; authority: ReturnType<typeof createLocalAuthority>; mode: 'edit' | 'play' } | undefined;
  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const delta = now - last;
    last = now;
    if (!session) return;
    if (session.mode === 'play') session.authority.advance(delta);
    report(session.authority.snapshot());
    session.scene.render();
  });
  const resize = () => engine.resize();
  window.addEventListener('resize', resize);
  return {
    restart(registry: readonly ModuleDefinition<CoreContext>[], selected: readonly string[], mode: 'edit' | 'play') {
      const old = session;
      session = undefined;
      old?.dispose();
      const scene = new Scene(engine);
      try {
        scene.clearColor = new Color4(0.035, 0.055, 0.08, 1);
        const camera = new ArcRotateCamera('camera', -Math.PI / 2, 1.05, 12, new Vector3(0, 1, 0), scene);
        camera.lowerRadiusLimit = 3;
        camera.upperRadiusLimit = 35;
        camera.attachControl(canvas, true);
        new HemisphericLight('light', new Vector3(0, 1, 0), scene);
        const authority = createLocalAuthority();
        const running = startModules(registry, selected, { scene, snapshot: () => authority.snapshot() });
        session = { scene, authority, mode, dispose() { try { running.dispose(); } finally { scene.dispose(); } } };
        last = performance.now();
      } catch (error) { scene.dispose(); throw error; }
    },
    dispose() {
      try { session?.dispose(); } finally { session = undefined; window.removeEventListener('resize', resize); engine.dispose(); }
    },
  };
}
