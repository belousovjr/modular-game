import {createElement} from 'react';
import {ControlPanel} from './panel.tsx';
import {createCameraObstacleSweep,recoverCameraRadius} from './camera-obstacles.ts';
import {createCameraGroundSweep} from './camera-ground.ts';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { KeyboardEventTypes } from '@babylonjs/core/Events/keyboardEvents.js';
import { defineModule } from '../../core/context.ts';
import { charactersModule,type CharacterStance } from '../characters/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { pedestrianBlockers, worldModule } from '../world/index.ts';

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
    const obstacleSweep=createCameraObstacleSweep(pedestrianBlockers(deps.world.collision));
    const arm=Vector3.Zero();
    let desiredRadius = 6, appliedRadius = 6, cameraHeight = 1.2;
    const keys = new Set<string>();
    let jump = false, leftHeld = false, rightHeld = false, freeLookAlpha = camera.alpha;
    let sequence = 0, lastTick = -6, lastInput = '', wasActive = false;
    let flightIntent:boolean|null=null;
    let stanceIntent:CharacterStance|undefined;
    const clearPointer = () => { leftHeld=false; rightHeld=false; };
    const clear = () => { keys.clear(); jump=false; flightIntent=null; stanceIntent=undefined; clearPointer(); lastInput = ''; };
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
      if(e.code==='KeyF'){
        e.preventDefault();
        if(info.type===KeyboardEventTypes.KEYDOWN&&!e.repeat){
          const state=deps.characters.snapshot();
          if(!state.vehicleId){flightIntent=!(flightIntent??state.mode==='fly');stanceIntent=undefined;}
        }
        return;
      }
      if (['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyC','KeyZ','ShiftLeft','ShiftRight','Space'].includes(e.code)) {
        e.preventDefault();
        if (info.type === KeyboardEventTypes.KEYDOWN) { keys.add(e.code); if(e.code==='Space' && !e.repeat) jump=true; }
      }
      if(info.type===KeyboardEventTypes.KEYDOWN&&!e.repeat&&(e.code==='KeyC'||e.code==='KeyZ')){
        const state=deps.characters.snapshot();
        if(state.mode==='walk'&&flightIntent!==true&&state.grounded&&!state.vehicleId){
          const selected=e.code==='KeyC'?'crouching':'prone';
          stanceIntent=(stanceIntent??state.stance)===selected?'standing':selected;
        }
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
      if(s.vehicleId){jump=false;flightIntent=null;stanceIntent=undefined;}
      if(flightIntent!==null&&flightIntent===(s.mode==='fly'))flightIntent=null;
      if(stanceIntent===s.stance||s.mode!=='walk')stanceIntent=undefined;
      const alpha=leftHeld&&!rightHeld?freeLookAlpha:camera.alpha;
      const free=s.mode!=='walk'||flightIntent===true;
      const prone=!free&&(s.stance==='prone'||stanceIntent==='prone');
      const forward = Number(keys.has('KeyW')) - Number(!prone&&keys.has('KeyS'));
      const right = prone&&forward===0?0:Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      const manualLift=free?Number(keys.has('Space'))-Number(keys.has('KeyC')):0;
      const pitch=free&&rightHeld&&manualLift===0?camera.beta-Math.PI/2:0;
      const pitchedForward=forward*Math.cos(pitch);
      const aimLift=forward*Math.sin(pitch);
      const lift=manualLift||(Math.abs(aimLift)>1e-5?aimLift:0);
      const x = -Math.cos(alpha)*pitchedForward - Math.sin(alpha)*right;
      const z = -Math.sin(alpha)*pitchedForward + Math.cos(alpha)*right;
      const facing=active&&rightHeld&&!prone?Math.atan2(forward||right?x:-Math.cos(camera.alpha),forward||right?z:-Math.sin(camera.alpha)):null;
      const length = Math.max(1,Math.hypot(x,lift,z));
      const run=keys.has('ShiftLeft')||keys.has('ShiftRight');
      const boost=keys.has('KeyQ');
      const input = `${x}/${z}/${run}/${facing}/${boost}/${lift}/${flightIntent}/${stanceIntent}`;
      if (!s.vehicleId && ((jump && s.tick > lastTick) || s.tick-lastTick >= 6 || (input !== lastInput && s.tick > lastTick) || (wasActive && !active))) {
        void deps.characters.send({type:'move',characterId:s.id,sequence:++sequence,tick:s.tick,x:x/length,z:z/length,
          run,jump:jump&&!free,facing,locomotion:{boost,lift:lift/length,flight:flightIntent},...(stanceIntent?{stance:stanceIntent}:{})});
        jump=false; lastTick = s.tick; lastInput = input;
      }
      wasActive = active;
      if (Math.abs(camera.radius-appliedRadius) > 1e-5) desiredRadius = Math.max(1.5,Math.min(10,desiredRadius+camera.radius-appliedRadius));
      if(s.vehicleId)desiredRadius=Math.max(6,desiredRadius);
      if (core.scene.activeCamera !== camera) return;
      const targetHeight=s.mode==='swim'?.95:s.stance==='prone'?.48:s.stance==='crouching'?.86:1.2;
      const deltaMs=core.scene.getEngine().getDeltaTime();
      cameraHeight+=(targetHeight-cameraHeight)*(1-Math.exp(-deltaMs/60));
      const target=new Vector3(s.x,s.y+cameraHeight,s.z);
      camera.setTarget(target,false,false,true);
      const horizontal=desiredRadius*Math.sin(camera.beta);
      arm.set(horizontal*Math.cos(camera.alpha),desiredRadius*Math.cos(camera.beta),horizontal*Math.sin(camera.alpha));
      const fraction=Math.min(groundSweep(target,arm),obstacleSweep(target,arm,desiredRadius));
      // Reconstructing the orbit from a near-zero position can reset alpha and beta.
      const safeRadius=Math.max(.05,desiredRadius*fraction);
      const previousRadius=Math.max(.05,camera.radius);
      camera.radius=appliedRadius=recoverCameraRadius(previousRadius,safeRadius,deltaMs);
      camera.getViewMatrix();
    };
    update();
    const observer = core.scene.onBeforeRenderObservable.add(update, -1, true);
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return {};
  },
});
