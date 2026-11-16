import type { Scope } from '../../core/modules.ts';
import { createElement } from 'react';
import { createAvatar, createCharacterAssets } from './assets.ts';
import { CharacterPanel } from './panel.tsx';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { defineModule } from '../../core/context.ts';
import { simulationModule } from '../simulation/index.tsx';
import { worldModule } from '../world/index.ts';
import { geometryModule } from '../geometry/index.ts';
import { createCharacterAuthority, createLocalConnection } from './headless.ts';
export type { MoveCommand, CharacterSnapshot, Receipt } from './headless.ts';

export const charactersModule = defineModule({
  id: 'characters', title: 'Персонаж', category: 'Игра',
  requires: { simulation: simulationModule, world: worldModule, geometry: geometryModule },
  setup({ core, deps, scope }) {
    let stopped=false;
    const authority = createCharacterAuthority(deps.world.collision, deps.simulation.snapshot().tick);
    const connection = createLocalConnection(authority);
    scope.onDispose(connection.close);
    deps.simulation.registerSystem(connection.step, scope);
    const assets=createCharacterAssets(core.scene,scope);
    scope.onDispose(core.panels.register('characters','Персонаж',createElement(CharacterPanel,{assets})));
    const createView=(owner: Scope)=>{if(stopped)throw new Error('Персонаж остановлен');return createAvatar(core.scene,deps.geometry,assets,owner);};
    const render = createView(scope);
    const update = () => render(connection.snapshot());
    update();
    const observer = core.scene.onBeforeRenderObservable.add(update, -1, true);
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    scope.onDispose(()=>{stopped=true;});
    return { send: connection.send, snapshot: connection.snapshot, createView, getAssetStatus:assets.getStatus, subscribeAssetStatus:assets.subscribe };
  },
  test: {
    durationSeconds: 6,
    setup({ core, deps, api, scope, report }) {
      const start = deps.simulation.snapshot().tick;
      const spawn=deps.world.collision.spawn;
      const actors=Array.from({length:16},(_,i)=>{
        const origin={x:spawn.x+(i%4-1.5)*1.2,z:spawn.z+(Math.floor(i/4)-1.5)*1.1};
        const session=createLocalConnection(createCharacterAuthority({...deps.world.collision,spawn:origin},start));
        scope.onDispose(session.close);
        return {session,render:api.createView(scope),origin};
      });
      const observer = core.scene.onBeforeRenderObservable.add(() => {
        const center=Vector3.Zero();
        for(const actor of actors) { const s=actor.session.snapshot();actor.render(s);center.addInPlaceFromFloats(s.x,s.y+1,s.z); }
        center.scaleInPlace(1/actors.length);
        const camera = core.scene.activeCamera;
        if (camera instanceof ArcRotateCamera) { camera.setTarget(center); camera.radius=13; }
      }, -1, true);
      scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
      let visibleMin=17;
      const visibility=core.scene.onAfterRenderObservable.add(()=>{
        if(api.getAssetStatus().state!=='ready')return;
        const meshes=core.scene.getActiveMeshes();let count=0;
        for(let i=0;i<meshes.length;i++)if(meshes.data[i].skeleton)count++;
        visibleMin=Math.min(visibleMin,count);
      });
      scope.onDispose(()=>core.scene.onAfterRenderObservable.remove(visibility));
      deps.simulation.registerSystem(tick => {
        for(const [i,actor] of actors.entries()) {
          const elapsed=tick-start;
          if(elapsed%6===1) void actor.session.send({type:'move',characterId:'local-player',sequence:elapsed,tick:tick-1,x:Math.floor(elapsed/45)%2===0?1:-1,z:0,run:i%2===0,jump:(elapsed+i*6)%120===1});
          actor.session.step(tick);
        }
      }, scope);
      scope.onDispose(() => report({actors:actors.length,visibleMin,tick:actors[0].session.snapshot().tick,distance:actors.reduce((sum,a)=>{const s=a.session.snapshot();return sum+Math.hypot(s.x-a.origin.x,s.z-a.origin.z);},0),lastSequence:actors[0].session.snapshot().lastSequence}));
      return () => {};
    },
  },
});
