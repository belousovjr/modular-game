import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { FreeCameraMouseInput } from '@babylonjs/core/Cameras/Inputs/freeCameraMouseInput.js';
import { FreeCameraKeyboardMoveInput } from '@babylonjs/core/Cameras/Inputs/freeCameraKeyboardMoveInput.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from './modules.ts';
import { DEFAULT_CAMERA_SETTINGS } from './camera-settings.ts';

export const FLIGHT_SPEED = 40;
export class SceneCamera extends FreeCamera {
  override _computeLocalCameraSpeed() {
    // Native keyboard scaling uses rolling FPS; use explicit units/second with inertia disabled.
    return this.speed * this.getEngine().getDeltaTime() / 1000;
  }
}
export function createFlyCamera(scene: Scene, scope: Scope) {
  const initial = DEFAULT_CAMERA_SETTINGS;
  const camera = new SceneCamera('camera', new Vector3(initial.position.x, initial.position.y, initial.position.z), scene);
  scope.onDispose(() => camera.dispose());
  camera.rotation.set(initial.rotation.x, initial.rotation.y, initial.rotation.z);
  camera.speed = FLIGHT_SPEED;
  camera.inertia = 0;
  camera.minZ = 0.1;
  camera.maxZ = 30000;
  camera.keysUp = [87];
  camera.keysDown = [83];
  camera.keysLeft = [65];
  camera.keysRight = [68];
  camera.keysUpward = [69];
  camera.keysDownward = [81];
  const mouse = camera.inputs.attached.mouse;
  if (mouse instanceof FreeCameraMouseInput) {
    mouse.buttons = [2];
    mouse.angularSensibility = 300;
  }
  camera.inputs.addMouseWheel();
  const keyboardInput = camera.inputs.attached.keyboard;
  const shortcuts = scene.onPreKeyboardObservable.add(info => {
    if (scene.activeCamera === camera && (info.event.ctrlKey || info.event.altKey || info.event.metaKey)) {
      if (keyboardInput instanceof FreeCameraKeyboardMoveInput) keyboardInput._onLostFocus();
      camera.speed = FLIGHT_SPEED;
      info.skipOnKeyboardObservable = true;
    }
  });
  scope.onDispose(() => scene.onPreKeyboardObservable.remove(shortcuts));
  const keyboard = scene.onKeyboardObservable.add(info => {
    if (scene.activeCamera === camera) camera.speed = info.event.shiftKey ? FLIGHT_SPEED * 4 : FLIGHT_SPEED;
  });
  scope.onDispose(() => scene.onKeyboardObservable.remove(keyboard));
  const blur = scene.getEngine().onCanvasBlurObservable.add(() => { camera.speed = FLIGHT_SPEED; });
  scope.onDispose(() => scene.getEngine().onCanvasBlurObservable.remove(blur));
  return camera;
}
