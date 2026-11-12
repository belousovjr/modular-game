import { readCamera, writeCamera } from './camera-settings.ts';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Observable } from '@babylonjs/core/Misc/observable';
import { createTestRunner, type TestState } from './test-runner.ts';
import type { RunnableTest } from './modules.ts';
import type { Panels } from './panels.ts';
import { startModules, type ModuleDefinition } from './modules.ts';
import type { CoreContext } from './context.ts';
export function createViewport(canvas: HTMLCanvasElement, reportFps: (fps: number) => void, panels: Panels, reportTest: (state: TestState) => void) {
  const engine = new Engine(canvas, true);
  let session: { scene: Scene; onFrame: Observable<number>; tests: readonly RunnableTest[]; dispose(): void } | undefined;
  let cameraSettings = readCamera();
  let savedCamera = JSON.stringify(cameraSettings);
  let lastCameraSave = 0;
  const runner = createTestRunner(reportTest, () => {
    const camera = session?.scene.activeCamera;
    if (!camera) throw new Error('Камера недоступна');
    camera.storeState();
    camera.detachControl();
    camera.restoreState();
    return () => { camera.restoreState(); camera.attachControl(canvas, true); };
  });
  function saveCamera() {
    const camera = session?.scene.activeCamera;
    if (!(camera instanceof ArcRotateCamera) || runner.getState().running) return;
    const target = camera.getTarget();
    cameraSettings = { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: { x: target.x, y: target.y, z: target.z } };
    const encoded = JSON.stringify(cameraSettings);
    if (encoded !== savedCamera) { writeCamera(cameraSettings); savedCamera = encoded; }
  }
  const visibility = () => { if (document.hidden) { runner.stop(); saveCamera(); } };
  document.addEventListener('visibilitychange', visibility);
  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const delta = now - last;
    last = now;
    if (!session) return;
    try { session.onFrame.notifyObservers(delta); session.scene.render(); }
    catch (error) { runner.fail(error); throw error; }
    runner.advance(delta);
    if (now - lastCameraSave >= 500) { saveCamera(); lastCameraSave = now; }
    reportFps(engine.getFps());
  });
  const resize = () => engine.resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  return {
    tests: {
      list: () => (session?.tests ?? []).map(({ id, title, durationSeconds }) => ({ id, title, durationSeconds })),
      getState: runner.getState,
      stop: runner.stop,
      run(ids?: readonly string[], durationSeconds?: number) {
        const available = session?.tests ?? [];
        const selected = ids ? [...new Set(ids)].map(id => {
          const test = available.find(test => test.id === id);
          if (!test) throw new Error(`Тест недоступен: ${id}. Сначала включите модуль.`);
          return test;
        }) : available;
        if (document.hidden) return Promise.reject(new Error('Для замера откройте вкладку с игрой'));
        return runner.run(selected, durationSeconds);
      },
    },
    restart(registry: readonly ModuleDefinition<CoreContext>[], selected: readonly string[], resetCamera = false) {
      if (runner.getState().running) throw new Error('Сначала остановите тест');
      saveCamera();
      const old = session;
      session = undefined;
      old?.dispose();
      const scene = new Scene(engine);
      try {
        scene.clearColor = new Color4(0.035, 0.055, 0.08, 1);
        const camera = new ArcRotateCamera('camera', -Math.PI / 2, 1.05, 12, new Vector3(0, 1, 0), scene);
        camera.lowerRadiusLimit = 3;
        camera.upperRadiusLimit = 35;
        if (cameraSettings && !resetCamera) {
          camera.setTarget(new Vector3(cameraSettings.target.x, cameraSettings.target.y, cameraSettings.target.z));
          camera.alpha = cameraSettings.alpha;
          camera.beta = cameraSettings.beta;
          camera.radius = cameraSettings.radius;
        }
        camera.attachControl(canvas, true);
        const onFrame = new Observable<number>();
        const running = startModules(registry, selected, { scene, onFrame, panels });
        session = { scene, onFrame, tests: running.tests, dispose() { try { running.dispose(); } finally { onFrame.clear(); scene.dispose(); } } };
        saveCamera();
        last = performance.now();
      } catch (error) { scene.dispose(); throw error; }
    },
    dispose() {
      runner.stop();
      saveCamera();
      document.removeEventListener('visibilitychange', visibility);
      try { session?.dispose(); } finally { session = undefined; observer.disconnect(); engine.dispose(); }
    },
  };
}
