import {createElement} from 'react';
import {ControlPanel} from './panel.tsx';
import {cameraObstacleFraction,recoverCameraRadius} from './camera-obstacles.ts';
import {createCameraGroundSweep} from './camera-ground.ts';
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
    scope.onDispose(core.panels.register('player-control','Управление',createElement(ControlPanel)));
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
    camera.lowerBetaLimit = 0.25; camera.upperBetaLimit = 2.65;
    camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    const pointers = camera.inputs.attached.pointers;
    if (pointers && 'buttons' in pointers) pointers.buttons = [0,2];
    previous?.detachControl();
    core.scene.activeCamera = camera;
    if (canvas) camera.attachControl(canvas,true);
    camera.movement.input.inputMap=[
      {source:'pointer',button:0,interaction:'rotate'},
      {source:'pointer',button:2,interaction:'rotate'},
      ...camera.movement.input.inputMap.filter(entry=>entry.source!=='pointer'),
    ];
    const groundSweep=createCameraGroundSweep(deps.world.collision);
    const arm=Vector3.Zero();
    let desiredRadius = 6, appliedRadius = 6;
    const keys = new Set<string>();
    let jump = false, leftHeld = false, rightHeld = false, freeLookAlpha = camera.alpha;
    let sequence = 0, lastTick = -6, lastInput = '', wasActive = false;
    const clearPointer = () => { leftHeld=false; rightHeld=false; };
    const clear = () => { keys.clear(); jump=false; clearPointer(); lastInput = ''; };
    if (canvas) {
      const down=(event:PointerEvent)=>{
        if(core.scene.activeCamera!==camera||document.hidden||event.ctrlKey||event.altKey||event.metaKey)return;
        if(event.button===0){leftHeld=true;freeLookAlpha=camera.alpha;}
        if(event.button===2)rightHeld=true;
        if(event.button===0||event.button===2)canvas.focus();
      };
      const up=(event:PointerEvent)=>{if(event.button===0)leftHeld=false;if(event.button===2)rightHeld=false;};
      const contextMenu=(event:Event)=>{if(core.scene.activeCamera===camera)event.preventDefault();};
      canvas.addEventListener('pointerdown',down);
      scope.onDispose(()=>canvas.removeEventListener('pointerdown',down));
      window.addEventListener('pointerup',up);
      scope.onDispose(()=>window.removeEventListener('pointerup',up));
      canvas.addEventListener('pointercancel',clearPointer);
      scope.onDispose(()=>canvas.removeEventListener('pointercancel',clearPointer));
      canvas.addEventListener('lostpointercapture',clearPointer);
      scope.onDispose(()=>canvas.removeEventListener('lostpointercapture',clearPointer));
      canvas.addEventListener('contextmenu',contextMenu);
      scope.onDispose(()=>canvas.removeEventListener('contextmenu',contextMenu));
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
      if (!active) clear();
      if(s.vehicleId)jump=false;
      const forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
      const right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      const alpha=leftHeld&&!rightHeld?freeLookAlpha:camera.alpha;
      const x = -Math.cos(alpha)*forward - Math.sin(alpha)*right;
      const z = -Math.sin(alpha)*forward + Math.cos(alpha)*right;
      const facing=active&&rightHeld?Math.atan2(forward||right?x:-Math.cos(camera.alpha),forward||right?z:-Math.sin(camera.alpha)):null;
      const length = Math.max(1,Math.hypot(x,z));
      const input = `${forward}/${right}/${keys.has('ShiftLeft') || keys.has('ShiftRight')}/${alpha}/${facing}`;
      if (!s.vehicleId && ((jump && s.tick > lastTick) || s.tick-lastTick >= 6 || (input !== lastInput && s.tick > lastTick) || (wasActive && !active))) {
        void deps.characters.send({ type:'move', characterId:s.id, sequence:++sequence, tick:s.tick, x:x/length, z:z/length, run:keys.has('ShiftLeft') || keys.has('ShiftRight'), jump, facing });
        jump=false; lastTick = s.tick; lastInput = input;
      }
      wasActive = active;
      if (Math.abs(camera.radius-appliedRadius) > 1e-5) desiredRadius = Math.max(1.5,Math.min(10,desiredRadius+camera.radius-appliedRadius));
      if(s.vehicleId)desiredRadius=Math.max(6,desiredRadius);
      if (core.scene.activeCamera !== camera) return;
      const target=new Vector3(s.x,s.y+1.2,s.z);
      camera.setTarget(target,false,false,true);
      const horizontal=desiredRadius*Math.sin(camera.beta);
      arm.set(horizontal*Math.cos(camera.alpha),desiredRadius*Math.cos(camera.beta),horizontal*Math.sin(camera.alpha));
      const fraction=Math.min(groundSweep(target,arm),cameraObstacleFraction(target,arm,desiredRadius,deps.world.collision.blockers));
      // Reconstructing the orbit from a near-zero position can reset alpha and beta.
      const safeRadius=Math.max(.05,desiredRadius*fraction);
      const previousRadius=Math.max(.05,camera.radius);
      camera.radius=appliedRadius=recoverCameraRadius(previousRadius,safeRadius,core.scene.getEngine().getDeltaTime());
      camera.getViewMatrix();
    };
    update();
    const observer = core.scene.onBeforeRenderObservable.add(update, -1, true);
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return {};
  },
});
