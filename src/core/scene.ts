import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Observable } from '@babylonjs/core/Misc/observable';
import type { Panels } from './panels.ts';
import { startModules, type ModuleDefinition } from './modules.ts';
import type { CoreContext } from './context.ts';
export function createViewport(canvas: HTMLCanvasElement, reportFps: (fps: number) => void, panels: Panels) {
  const engine = new Engine(canvas, true);
  let session: { scene: Scene; onFrame: Observable<number>; dispose(): void } | undefined;
  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const delta = now - last;
    last = now;
    if (!session) return;
    session.onFrame.notifyObservers(delta);
    session.scene.render();
    reportFps(engine.getFps());
  });
  const resize = () => engine.resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  return {
    restart(registry: readonly ModuleDefinition<CoreContext>[], selected: readonly string[]) {
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
        const onFrame = new Observable<number>();
        const running = startModules(registry, selected, { scene, onFrame, panels });
        session = { scene, onFrame, dispose() { try { running.dispose(); } finally { onFrame.clear(); scene.dispose(); } } };
        last = performance.now();
      } catch (error) { scene.dispose(); throw error; }
    },
    dispose() {
      try { session?.dispose(); } finally { session = undefined; observer.disconnect(); engine.dispose(); }
    },
  };
}
