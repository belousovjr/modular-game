import type {TrafficContact, TrafficPoint, TrafficSample} from '../../simulation/traffic.ts';
import type {CollisionBox} from '../world/index.ts';
import type { Scope } from '../../core/modules.ts';
import { createElement } from 'react';
import { createScope } from '../../core/scope.ts';
import { createAvatar, createCharacterAssets } from './assets.ts';
import { CharacterPanel } from './panel.tsx';
import {npcAppearance,readAppearance,saveAppearance,type Appearance} from './appearance.ts';
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
    const position = core.play ? undefined : readLocalPosition();
    const authority = createAuthority(start, undefined, position);
    scope.onDispose(authority.dispose);
    const connection = createLocalConnection(authority, {}, deps.simulation.session);
    scope.onDispose(connection.close);
    const online = deps.simulation.online;
    const snapshot = () => online.self() ?? connection.snapshot();
    let saved=connection.snapshot();
    trackLocalCheckpoint(core.onFrame,scope,()=>{
      if (core.play) return;
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
    const appearance=core.play ? npcAppearance(core.play.characterId) : readAppearance();
    const render=createView(scope,appearance);
    scope.onDispose(core.panels.register('characters','Персонаж',createElement(CharacterPanel,{
      assets,initial:appearance,onChange(next){
        render.setAppearance(next);
        saveAppearance(next);
      },
    })));
    const sampleHeight=createDisplayHeight();
    let displayY=sampleHeight(snapshot(),0);
    let displayX=snapshot().x, displayZ=snapshot().z;
    let displayedIdentity='';
    const remoteViews=new Map<string, { owner: ReturnType<typeof createScope>; render: ReturnType<typeof createView> }>();
    scope.onDispose(() => { for (const view of remoteViews.values()) view.owner.dispose(); });
    deps.interiors.presentDoorSnapshot(connection.snapshot().entranceDoors);
    const reset=core.onResetView?.add(()=>{
      if (core.play) return;
      connection.resetPosition();
      resetVehicleOccupancy?.();
      const snapshot=connection.snapshot();
      displayY=sampleHeight(snapshot,0,true);
      if(saveLocalPosition(snapshot))saved=snapshot;
    });
    if(reset)scope.onDispose(()=>core.onResetView?.remove(reset));
    const smoothing=core.onFrame.add(delta=>{
      const state=snapshot();
      const identity=online.identity();
      const reset=identity!==displayedIdentity || Math.hypot(state.x-displayX,state.z-displayZ)>3;
      displayedIdentity=identity;
      const blend=identity&&!reset ? 1-Math.exp(-delta/55) : 1;
      displayX+=(state.x-displayX)*blend;
      displayZ+=(state.z-displayZ)*blend;
      displayY=sampleHeight(state,delta,reset);
      deps.interiors.presentDoorSnapshot(state.entranceDoors);
    });
    scope.onDispose(()=>core.onFrame.remove(smoothing));
    const update = () => {
      const state=snapshot();
      render(online.self() ? { ...state, x: displayX, z: displayZ } : state,displayY);
      const remote=online.remote();
      for (const [id, view] of remoteViews) if (!remote.some(actor => actor.id===id)) {
        view.owner.dispose();
        remoteViews.delete(id);
      }
      for (const actor of remote) {
        let view=remoteViews.get(actor.id);
        if (!view) {
          const owner=createScope();
          try { view={ owner, render:createView(owner,npcAppearance(actor.id)) }; }
          catch (error) { owner.dispose(); throw error; }
          remoteViews.set(actor.id,view);
        }
        view.render(actor);
      }
    };
    scope.onDispose(()=>deps.interiors.presentDoorSnapshot(undefined));
    update();
    const observer = core.scene.onBeforeRenderObservable.add(update, -1, true);
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    scope.onDispose(()=>{stopped=true;});
    return {
      registerTrafficAuthority(provider:NonNullable<typeof traffic>,owner:Scope){
        if(stopped||traffic)throw new Error('Traffic authority already connected or stopped');
        deps.simulation.blockOnline(owner);
        traffic=provider;
        owner.onDispose(()=>{traffic=undefined;authority.setTrafficBlockers([]);});
      },
      vehicleTraffic(point:TrafficPoint){return traffic?.around(point)??[];},
      vehicleTrafficContacts(hits:readonly TrafficContact[]){traffic?.contacts(hits);},
      registerVehicleAuthority(step:(tick:number,character:CharacterSnapshot)=>VehicleCharacterFrame,owner:Scope,resetOccupancy:()=>void){
        if(stopped)throw new Error('Персонаж остановлен');
        if(vehicleStep)throw new Error('Vehicle authority already connected');
        deps.simulation.blockOnline(owner);
        vehicleStep=step;resetVehicleOccupancy=resetOccupancy;
        owner.onDispose(()=>{vehicleStep=null;resetVehicleOccupancy=undefined;authority.setVehicleFrame(null);});
      },
      enableOnline(owner: Scope) {
        const world=deps.world.getNavigationSource();
        deps.simulation.enableOnline(`${world.id}/${world.version}`,owner);
      },
      send: (command: Parameters<typeof connection.send>[0]) => online.self() ? online.send(command) : connection.send(command),
      snapshot, displayHeight:()=>displayY, displayPosition:()=>({x:displayX,z:displayZ}), createView,
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
