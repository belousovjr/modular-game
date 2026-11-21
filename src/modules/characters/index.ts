import type {TrafficContact, TrafficPoint, TrafficSample} from '../../simulation/traffic.ts';
import type {CollisionBox} from '../world/index.ts';
import type { Scope } from '../../core/modules.ts';
import { createElement } from 'react';
import { createAvatar, createCharacterAssets } from './assets.ts';
import { CharacterPanel } from './panel.tsx';
import {readAppearance,saveAppearance,type Appearance} from './appearance.ts';
export {npcAppearance} from './appearance.ts';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { defineModule } from '../../core/context.ts';
import { trackLocalCheckpoint } from '../../core/local-checkpoint.ts';
import { createDisplayHeight } from './height-presentation.ts';
import { readLocalPosition, saveLocalPosition } from './local-position.ts';
import { simulationModule } from '../simulation/index.tsx';
import { worldModule } from '../world/index.ts';
import { geometryModule } from '../geometry/index.ts';
import { buildingInteriorsModule } from '../building-interiors/index.ts';
import type { VehicleCharacterFrame,CharacterSnapshot } from './headless.ts';
import { createCharacterAuthorityFactory, createLocalConnection } from './headless.ts';
export { clearLocalPosition } from './local-position.ts';
export type { MoveCommand, CharacterSnapshot, CharacterStance, Receipt } from './headless.ts';

export const charactersModule = defineModule({
  id: 'characters', title: 'Персонаж', category: 'Игра',
  requires: { simulation: simulationModule, world: worldModule, geometry: geometryModule, interiors: buildingInteriorsModule },
  setup({ core, deps, scope }) {
    let stopped=false;
    const createAuthority = createCharacterAuthorityFactory(deps.world.collision,deps.world.getBuildingInteriorSources(),deps.interiors.collision);
    const start = deps.simulation.snapshot().tick;
    const position = readLocalPosition();
    const authority = createAuthority(start, undefined, position);
    scope.onDispose(authority.dispose);
    const connection = createLocalConnection(authority);
    scope.onDispose(connection.close);
    let saved=connection.snapshot();
    trackLocalCheckpoint(core.onFrame,scope,()=>{
      const next=connection.snapshot();
      if (next.x===saved.x && next.y===saved.y && next.z===saved.z) return;
      if (saveLocalPosition(next)) saved=next;
    });
    let resetVehicleOccupancy:(()=>void)|undefined;
    let vehicleStep:((tick:number,character:CharacterSnapshot)=>VehicleCharacterFrame)|null=null;
    let traffic:{step:(tick:number,hero:CharacterSnapshot)=>readonly CollisionBox[];
      around:(point:TrafficPoint)=>readonly TrafficSample[]; contacts:(hits:readonly TrafficContact[])=>void}|undefined;
    deps.simulation.registerSystem(tick=>{
      const hero=authority.snapshot();
      authority.setTrafficBlockers(traffic?.step(tick,hero)??[]);
      if(vehicleStep)authority.setVehicleFrame(vehicleStep(tick,hero));
      connection.step(tick);
    }, scope);
    const assets=createCharacterAssets(core.scene,scope);
    const createView=(owner:Scope,appearance?:Appearance)=>{
      if(stopped)throw new Error('Персонаж остановлен');
      return createAvatar(core.scene,deps.geometry,assets,owner,appearance);
    };
    const appearance=readAppearance();
    const render=createView(scope,appearance);
    scope.onDispose(core.panels.register('characters','Персонаж',createElement(CharacterPanel,{
      assets,initial:appearance,onChange(next){
        render.setAppearance(next);
        saveAppearance(next);
      },
    })));
    const sampleHeight=createDisplayHeight();
    let displayY=sampleHeight(connection.snapshot(),0);
    deps.interiors.presentDoorSnapshot(connection.snapshot().entranceDoors);
    const reset=core.onResetView?.add(()=>{
      connection.resetPosition();
      resetVehicleOccupancy?.();
      const snapshot=connection.snapshot();
      displayY=sampleHeight(snapshot,0,true);
      if(saveLocalPosition(snapshot))saved=snapshot;
    });
    if(reset)scope.onDispose(()=>core.onResetView?.remove(reset));
    const smoothing=core.onFrame.add(delta=>{
      const snapshot=connection.snapshot();
      displayY=sampleHeight(snapshot,delta);
      deps.interiors.presentDoorSnapshot(snapshot.entranceDoors);
    });
    scope.onDispose(()=>core.onFrame.remove(smoothing));
    const update = () => {
      const snapshot=connection.snapshot();
      render(snapshot,displayY);
    };
    scope.onDispose(()=>deps.interiors.presentDoorSnapshot(undefined));
    update();
    const observer = core.scene.onBeforeRenderObservable.add(update, -1, true);
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    scope.onDispose(()=>{stopped=true;});
    return {
      registerTrafficAuthority(provider:NonNullable<typeof traffic>,owner:Scope){
        if(stopped||traffic)throw new Error('Traffic authority already connected or stopped');
        traffic=provider;
        owner.onDispose(()=>{traffic=undefined;authority.setTrafficBlockers([]);});
      },
      vehicleTraffic(point:TrafficPoint){return traffic?.around(point)??[];},
      vehicleTrafficContacts(hits:readonly TrafficContact[]){traffic?.contacts(hits);},
      registerVehicleAuthority(step:(tick:number,character:CharacterSnapshot)=>VehicleCharacterFrame,owner:Scope,resetOccupancy:()=>void){
        if(stopped)throw new Error('Персонаж остановлен');
        if(vehicleStep)throw new Error('Vehicle authority already connected');
        vehicleStep=step;resetVehicleOccupancy=resetOccupancy;
        owner.onDispose(()=>{vehicleStep=null;resetVehicleOccupancy=undefined;authority.setVehicleFrame(null);});
      },
      send: connection.send, snapshot: connection.snapshot, displayHeight:()=>displayY, createView,
      getAssetStatus:assets.getStatus, subscribeAssetStatus:assets.subscribe,
    };
  },
  test: {
    durationSeconds: 6,
    setup({ core, deps, api, scope, report }) {
      const start = deps.simulation.snapshot().tick;
      const spawn=deps.world.collision.spawn;
      const createAuthority=createCharacterAuthorityFactory(deps.world.collision);
      const actors=Array.from({length:16},(_,i)=>{
        const origin={x:spawn.x+(i%4-1.5)*1.2,z:spawn.z+(Math.floor(i/4)-1.5)*1.1};
        const session=createLocalConnection(createAuthority(start,origin));
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
