import { readCamera, writeCamera } from './camera-settings.ts';
import { createFlyCamera, FLIGHT_SPEED, SceneCamera } from './fly-camera.ts';
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
    camera.detachControl();
    if (camera instanceof SceneCamera) {
      camera.speed = FLIGHT_SPEED;
      camera.cameraDirection.setAll(0);
      camera.cameraRotation.setAll(0);
      camera.movement.resetPanVelocity();
      camera.movement.resetRotationVelocity();
    }
    const testCamera = new ArcRotateCamera('test-camera', -Math.PI / 2, 1.05, 12, new Vector3(0, 1, 0), camera.getScene());
    testCamera.maxZ = 30000;
    camera.getScene().activeCamera = testCamera;
    return () => { testCamera.dispose(); camera.getScene().activeCamera = camera; camera.attachControl(canvas, true); };
  });
  function saveCamera() {
    const camera = session?.scene.activeCamera;
    if (!(camera instanceof SceneCamera) || runner.getState().running) return;
    cameraSettings = {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      rotation: { x: camera.rotation.x, y: camera.rotation.y, z: camera.rotation.z },
    };
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
        const camera = createFlyCamera(scene, { onDispose: cleanup => { scene.onDisposeObservable.addOnce(cleanup); } });
        if (cameraSettings && !resetCamera) {
          const { position, rotation } = cameraSettings;
          camera.position.set(position.x, position.y, position.z);
          camera.rotation.set(rotation.x, rotation.y, rotation.z);
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
