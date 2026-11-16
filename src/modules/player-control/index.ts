import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { KeyboardEventTypes } from '@babylonjs/core/Events/keyboardEvents.js';
import { defineModule } from '../../core/context.ts';
import { charactersModule } from '../characters/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { worldModule } from '../world/index.ts';

export const playerControlModule = defineModule({
  id: 'player-control', title: 'Управление персонажем', category: 'Игра',
  requires: { characters: charactersModule, rendering: objectRenderingModule, world: worldModule },
  setup({ core, deps, scope }) {
    const previous = core.scene.activeCamera;
    const canvas = core.scene.getEngine().getRenderingCanvas();
    const camera = new ArcRotateCamera('player-camera', -Math.PI/2, 1.1, 6, Vector3.Zero(), core.scene);
    scope.onDispose(() => {
      const restore = core.scene.activeCamera === camera;
      camera.dispose();
      if (restore) { core.scene.activeCamera = previous; if (canvas) previous?.attachControl(canvas,true); }
    });
    camera.minZ = 0.1; camera.maxZ = 30000;
    camera.lowerRadiusLimit = 0.05; camera.upperRadiusLimit = 10;
    camera.lowerBetaLimit = 0.25; camera.upperBetaLimit = 1.48;
    camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    const pointers = camera.inputs.attached.pointers;
    if (pointers && 'buttons' in pointers) pointers.buttons = [2];
    previous?.detachControl();
    core.scene.activeCamera = camera;
    if (canvas) camera.attachControl(canvas,true);
    let desiredRadius = 6, appliedRadius = 6;
    const keys = new Set<string>();
    let jump = false;
    let sequence = 0, lastTick = -6, lastInput = '', wasActive = false;
    const clear = () => { keys.clear(); jump=false; lastInput = ''; };
    if (canvas) {
      canvas.addEventListener('blur',clear);
      scope.onDispose(() => canvas.removeEventListener('blur',clear));
    }
    window.addEventListener('blur',clear);
    scope.onDispose(() => window.removeEventListener('blur',clear));
    const keyboard = core.scene.onKeyboardObservable.add(info => {
      const e = info.event;
      if (info.type === KeyboardEventTypes.KEYUP) keys.delete(e.code);
      if (!canvas || document.activeElement !== canvas || core.scene.activeCamera !== camera || e.ctrlKey || e.altKey || e.metaKey || document.hidden) { clear(); return; }
      if (['KeyW','KeyA','KeyS','KeyD','ShiftLeft','ShiftRight','Space'].includes(e.code)) {
        e.preventDefault();
        if (info.type === KeyboardEventTypes.KEYDOWN) { keys.add(e.code); if(e.code==='Space' && !e.repeat) jump=true; }
      }
    });
    scope.onDispose(() => core.scene.onKeyboardObservable.remove(keyboard));
    deps.rendering.setDistanceSource(() => {
      if (core.scene.activeCamera === camera) { const s = deps.characters.snapshot(); return { x:s.x,y:s.y,z:s.z }; }
      // Core scenarios explicitly use their test camera while player input is suspended.
      const testCamera = core.scene.activeCamera;
      testCamera?.getViewMatrix(true);
      return testCamera?.globalPosition ?? null;
    }, scope);
    const update = () => {
      const s = deps.characters.snapshot();
      const active = core.scene.activeCamera === camera && !document.hidden && document.activeElement === canvas;
      if (!active) { keys.clear(); jump=false; }
      const forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
      const right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      const x = -Math.cos(camera.alpha)*forward - Math.sin(camera.alpha)*right;
      const z = -Math.sin(camera.alpha)*forward + Math.cos(camera.alpha)*right;
      const length = Math.max(1,Math.hypot(x,z));
      const input = `${forward}/${right}/${keys.has('ShiftLeft') || keys.has('ShiftRight')}/${camera.alpha}`;
      if ((jump && s.tick > lastTick) || s.tick-lastTick >= 6 || (input !== lastInput && s.tick > lastTick) || (wasActive && !active)) {
        void deps.characters.send({ type:'move', characterId:s.id, sequence:++sequence, tick:s.tick, x:x/length, z:z/length, run:keys.has('ShiftLeft') || keys.has('ShiftRight'), jump });
        jump=false; lastTick = s.tick; lastInput = input;
      }
      wasActive = active;
      if (Math.abs(camera.radius-appliedRadius) > 1e-5) desiredRadius = Math.max(1.5,Math.min(10,desiredRadius+camera.radius-appliedRadius));
      camera.radius = desiredRadius;
      camera.setTarget(new Vector3(s.x,s.y+1.2,s.z), false, false, true);
      if (core.scene.activeCamera !== camera) return;
      // Camera sphere/box sweep uses static world data, including unloaded buildings.
      camera.getViewMatrix(true);
      const target = camera.target, delta = camera.position.subtract(target);
      let fraction = 1;
      const minX=Math.min(target.x,camera.position.x)-.2,maxX=Math.max(target.x,camera.position.x)+.2;
      const minZ=Math.min(target.z,camera.position.z)-.2,maxZ=Math.max(target.z,camera.position.z)+.2;
      for (const b of deps.world.collision.blockers) {
        if(b.maxX<minX||b.minX>maxX||b.maxZ<minZ||b.minZ>maxZ)continue;
        let enter = 0, exit = 1;
        for (const [origin,direction,min,max] of [[target.x,delta.x,b.minX-.2,b.maxX+.2],[target.y,delta.y,b.minY-.2,b.maxY+.2],[target.z,delta.z,b.minZ-.2,b.maxZ+.2]]) {
          if (Math.abs(direction) < 1e-9) { if (origin < min || origin > max) { enter=2; break; } }
          else { const a=(min-origin)/direction,c=(max-origin)/direction; enter=Math.max(enter,Math.min(a,c)); exit=Math.min(exit,Math.max(a,c)); }
        }
        if (enter <= exit && enter >= 0 && enter <= 1) fraction = Math.min(fraction,Math.max(0,enter-.02/Math.max(delta.length(),.001)));
      }
      if (fraction < 1) camera.setPosition(target.add(delta.scale(fraction)));
      appliedRadius = camera.radius;
    };
    update();
    const observer = core.scene.onBeforeRenderObservable.add(update, -1, true);
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return {};
  },
});
