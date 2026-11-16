import { defineModule } from '../../core/context.ts';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { charactersModule } from '../characters/index.ts';
import { worldModule } from '../world/index.ts';
import { simulationModule } from '../simulation/index.tsx';
import { createNpcAuthority, downtownPatrols } from './headless.ts';

export const npcModule=defineModule({
  id:'npc',title:'Пешеходы',category:'Игра',
  requires:{characters:charactersModule,world:worldModule,simulation:simulationModule},
  setup({core,deps,scope}){
    let stopped=false;scope.onDispose(()=>{stopped=true;});
    const authority=createNpcAuthority(deps.world.collision,downtownPatrols,8,deps.simulation.snapshot().tick);
    deps.simulation.registerSystem(authority.step,scope);
    const views=authority.snapshot().actors.map(()=>deps.characters.createView(scope));
    const render=()=>{for(const [i,s] of authority.snapshot().actors.entries())views[i](s);};
    render();const observer=core.scene.onBeforeRenderObservable.add(render,-1,true);
    scope.onDispose(()=>core.scene.onBeforeRenderObservable.remove(observer));
    return {snapshot(){if(stopped)throw new Error('Пешеходы остановлены');return authority.snapshot();}};
  },
  test:{durationSeconds:8,setup({core,deps,scope,report}){
    const authority=createNpcAuthority(deps.world.collision,downtownPatrols,16,deps.simulation.snapshot().tick,'npc-test');
    deps.simulation.registerSystem(authority.step,scope);
    const views=authority.snapshot().actors.map(()=>deps.characters.createView(scope));
    const camera=core.scene.activeCamera;
    if(camera instanceof ArcRotateCamera){const upper=camera.upperRadiusLimit;scope.onDispose(()=>{camera.upperRadiusLimit=upper;});camera.upperRadiusLimit=150;}
    let visibleMin=16;
    const visible=core.scene.onAfterRenderObservable.add(()=>{
      if(deps.characters.getAssetStatus().state!=='ready')return;
      let count=0;const active=core.scene.getActiveMeshes();
      for(let i=0;i<active.length;i++){let node=active.data[i].parent;while(node){if(node.name.startsWith('character/npc-test/')){count++;break;}node=node.parent;}}
      visibleMin=Math.min(visibleMin,count);
    });
    scope.onDispose(()=>core.scene.onAfterRenderObservable.remove(visible));
    const observer=core.scene.onBeforeRenderObservable.add(()=>{
      for(const [i,s] of authority.snapshot().actors.entries())views[i](s);
      const camera=core.scene.activeCamera;
      if(camera instanceof ArcRotateCamera){camera.setTarget(new Vector3(25,2,-32));camera.radius=125;}
    },-1,true);
    scope.onDispose(()=>core.scene.onBeforeRenderObservable.remove(observer));
    scope.onDispose(()=>{const s=authority.snapshot();report({actors:s.actors.length,visibleMin,arrivals:s.arrivals,moving:s.actors.filter(a=>a.moving).length,tick:s.tick});});
    return ()=>{};
  }},
});
