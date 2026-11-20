import { defineModule } from '../../core/context.ts';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from '../../core/modules.ts';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { charactersModule } from '../characters/index.ts';
import { worldModule } from '../world/index.ts';
import { simulationModule } from '../simulation/index.tsx';
import { createNpcAuthority, downtownPatrols } from './headless.ts';

const DRAW_DISTANCE={show:100,hide:110};

function createMarkerSource(scene:Scene,scope:Scope){
  const marker=CreateSphere('npc/marker-source',{diameter:.2,segments:6},scene);
  scope.onDispose(()=>marker.dispose());
  marker.position.y=2.12;
  marker.setEnabled(false);
  const material=new StandardMaterial('npc/marker-white',scene);
  scope.onDispose(()=>material.dispose());
  material.disableLighting=true;
  material.emissiveColor=Color3.White();
  marker.material=material;
  return marker;
}

export const npcModule=defineModule({
  id:'npc',title:'Пешеходы',category:'Игра',
  requires:{characters:charactersModule,world:worldModule,simulation:simulationModule},
  setup({core,deps,scope}){
    let stopped=false;scope.onDispose(()=>{stopped=true;});
    const authority=createNpcAuthority(deps.world.collision,downtownPatrols,8,deps.simulation.snapshot().tick,'npc',deps.characters.createNpcCharacter);
    scope.onDispose(authority.dispose);
    deps.simulation.registerSystem(authority.step,scope);
    const marker=createMarkerSource(core.scene,scope);
    const views=authority.snapshot().actors.map(()=>deps.characters.createView(scope,DRAW_DISTANCE,marker));
    const render=()=>{for(const [i,s] of authority.snapshot().actors.entries())views[i](s);};
    render();const observer=core.scene.onBeforeRenderObservable.add(render,-1,true);
    scope.onDispose(()=>core.scene.onBeforeRenderObservable.remove(observer));
    return {snapshot(){if(stopped)throw new Error('Пешеходы остановлены');return authority.snapshot();}};
  },
  test:{durationSeconds:8,setup({core,deps,scope,report}){
    const authority=createNpcAuthority(deps.world.collision,downtownPatrols,16,deps.simulation.snapshot().tick,'npc-test');
    scope.onDispose(authority.dispose);
    deps.simulation.registerSystem(authority.step,scope);
    const marker=createMarkerSource(core.scene,scope);
    const views=authority.snapshot().actors.map(()=>deps.characters.createView(scope,DRAW_DISTANCE,marker));
    const camera=core.scene.activeCamera;
    if(camera instanceof ArcRotateCamera){const upper=camera.upperRadiusLimit;scope.onDispose(()=>{camera.upperRadiusLimit=upper;});camera.upperRadiusLimit=150;}
    let visibleMin=16;
    const visible=core.scene.onAfterRenderObservable.add(()=>{
      if(deps.characters.getAssetStatus().state!=='ready')return;
      let count=0;const active=core.scene.getActiveMeshes();
      for(let i=0;i<active.length;i++){if(!active.data[i].skeleton)continue;let node=active.data[i].parent;while(node){if(node.name.startsWith('character/npc-test/')){count++;break;}node=node.parent;}}
      visibleMin=Math.min(visibleMin,count);
    });
    scope.onDispose(()=>core.scene.onAfterRenderObservable.remove(visible));
    const target=new Vector3(25,2,-32);
    const observer=core.scene.onBeforeRenderObservable.add(()=>{
      const camera=core.scene.activeCamera;
      if(camera instanceof ArcRotateCamera){camera.setTarget(target);camera.radius=85;}
      for(const [i,s] of authority.snapshot().actors.entries())views[i](s);
    },-1,true);
    scope.onDispose(()=>core.scene.onBeforeRenderObservable.remove(observer));
    scope.onDispose(()=>{const s=authority.snapshot();report({actors:s.actors.length,visibleMin,arrivals:s.arrivals,moving:s.actors.filter(a=>a.moving).length,tick:s.tick});});
    return ()=>{};
  }},
});
