import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { KeyboardEventTypes, KeyboardInfo, KeyboardInfoPre } from '@babylonjs/core/Events/keyboardEvents.js';
import { FreeCameraMouseInput } from '@babylonjs/core/Cameras/Inputs/freeCameraMouseInput.js';
import { createFlyCamera, FLIGHT_SPEED } from '../src/core/fly-camera.ts';

test('free flight covers the same distance at different FPS and stops without inertia', t => {
  for (const fps of [15, 30, 60, 144]) {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const cleanups: (() => void)[] = [];
    const camera = createFlyCamera(scene, { onDispose: cleanup => cleanups.push(cleanup) });
    t.mock.method(engine, 'getDeltaTime', () => 1000 / fps);
    camera.position.setAll(0);
    camera.rotation.setAll(0);
    for (let frame = 0; frame < fps; frame++) {
      camera.cameraDirection.z += camera._computeLocalCameraSpeed();
      camera._checkInputs();
    }
    assert.ok(Math.abs(camera.position.z - FLIGHT_SPEED) < 1e-5, `${fps} FPS: ${camera.position.z}`);
    camera._checkInputs();
    assert.ok(Math.abs(camera.position.z - FLIGHT_SPEED) < 1e-5);
    const mouse = camera.inputs.attached.mouse;
    assert.ok(mouse instanceof FreeCameraMouseInput);
    assert.deepEqual(mouse.buttons, [2]);
    assert.deepEqual(camera.keysUp, [87]);
    assert.deepEqual(camera.keysDownward, [81]);
    scene.onKeyboardObservable.notifyObservers(new KeyboardInfo(KeyboardEventTypes.KEYDOWN, {
      type: 'keydown', inputIndex: 16, target: null, preventDefault() {},
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: true, code: 'ShiftLeft', key: 'Shift', keyCode: 16,
    }));
    assert.equal(camera.speed, FLIGHT_SPEED * 4);
    const shortcut = new KeyboardInfoPre(KeyboardEventTypes.KEYDOWN, {
      type: 'keydown', inputIndex: 83, target: null, preventDefault() {},
      altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, code: 'KeyS', key: 's', keyCode: 83,
    });
    scene.onPreKeyboardObservable.notifyObservers(shortcut);
    assert.equal(shortcut.skipOnKeyboardObservable, true);
    assert.equal(camera.speed, FLIGHT_SPEED);
    engine.onCanvasBlurObservable.notifyObservers(engine);
    assert.equal(camera.speed, FLIGHT_SPEED);
    for (const cleanup of cleanups.reverse()) cleanup();
    assert.equal(scene.onKeyboardObservable.hasObservers(), false);
    assert.equal(scene.onPreKeyboardObservable.hasObservers(), false);
    scene.dispose(); engine.dispose();
  }
});
