import {defineModule} from '../../core/context.ts';
import {worldModule} from '../world/index.ts';
import {activeStreetLampPhases, FIRST_WINDOW_THRESHOLD, materialsModule, streetLampPhase} from '../materials/index.ts';
import {geometryModule} from '../geometry/index.ts';
import {atmosphereModule} from '../atmosphere/index.tsx';
import {RawTexture} from '@babylonjs/core/Materials/Textures/rawTexture.js';
import {Texture} from '@babylonjs/core/Materials/Textures/texture.js';
import {PBRMaterial} from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import {SpotLight} from '@babylonjs/core/Lights/spotLight.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {Color3} from '@babylonjs/core/Maths/math.color.js';
import {DefaultRenderingPipeline} from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js';
import {bakeNightField} from './field.ts';

export const nightLightingModule=defineModule({id:'night-lighting',title:'Ночное освещение',category:'Рендеринг',requires:{world:worldModule,materials:materialsModule,geometry:geometryModule,atmosphere:atmosphereModule},setup({core,deps,scope}){
  // shortcut: one map for this downtown; tile it when expansion makes lamp pools smaller than a few texels.
  const baked=bakeNightField(deps.world.streetLights,deps.world.collision.blockers,deps.world.bounds,streetLampPhase);
  const texture=RawTexture.CreateRGBATexture(baked.data,baked.size,baked.size*2,core.scene,false,false,Texture.BILINEAR_SAMPLINGMODE);scope.onDispose(()=>texture.dispose());
  texture.name='night-lighting/field';texture.gammaSpace=false;texture.wrapU=texture.wrapV=Texture.CLAMP_ADDRESSMODE;
  const field=deps.materials.registerNightField(texture,deps.world.bounds,scope);
  const lights=Array.from({length:2},(_,i)=>{
    const light=new SpotLight(`night-lighting/lamp/${i}`,Vector3.Zero(),Vector3.Down(),1.8,2,core.scene);scope.onDispose(()=>light.dispose());
    light.diffuse=Color3.FromHexString('#ffe1b0');light.specular=Color3.Black();light.range=16;light.intensity=0;light.setEnabled(false);return light;
  });
  const pipeline=new DefaultRenderingPipeline('night-lighting/glow',false,core.scene,[],false);scope.onDispose(()=>pipeline.dispose());
  pipeline.imageProcessingEnabled=false;pipeline.bloomScale=.25;pipeline.bloomKernel=48;pipeline.bloomThreshold=.10;pipeline.bloomWeight=.22;
  let night=0,phases=0,bloom=false,camera=core.scene.activeCamera,elapsed=250,stopped=false;
  if(camera)pipeline.addCamera(camera);pipeline.prepare();
  scope.onDispose(()=>{stopped=true;});
  function update(){
    night=deps.atmosphere.getSnapshot().night;field.setNight(night);
    const nextPhases=activeStreetLampPhases(night);
    if(nextPhases!==phases){phases=nextPhases;elapsed=250;}
    const enabled=night>=FIRST_WINDOW_THRESHOLD;if(enabled!==bloom){bloom=enabled;pipeline.bloomEnabled=enabled;pipeline.prepare();}
  }
  update();scope.onDispose(deps.atmosphere.subscribe(update));
  const observer=core.scene.onBeforeRenderObservable.add(()=>{
    const active=core.scene.activeCamera;
    if(active!==camera){if(camera)pipeline.removeCamera(camera);camera=active;if(camera)pipeline.addCamera(camera);pipeline.prepare();}
    elapsed+=core.scene.getEngine().getDeltaTime();if(elapsed<250)return;elapsed=0;
    if(!camera||phases===0){for(const light of lights)light.setEnabled(false);return;}
    camera.getViewMatrix();const p=camera.globalPosition;
    // Only movable PBR assets need live lamps; static streets share the baked field.
    const meshes=[...deps.geometry.getMeshes()].filter(m=>m.material instanceof PBRMaterial);
    const nearest=deps.world.streetLights.filter(l=>streetLampPhase(l.x,l.z)<phases&&Math.hypot(l.x-p.x,l.y-p.y,l.z-p.z)<35).sort((a,b)=>Math.hypot(a.x-p.x,a.y-p.y,a.z-p.z)-Math.hypot(b.x-p.x,b.y-p.y,b.z-p.z)).slice(0,2);
    for(let i=0;i<lights.length;i++){
      const light=lights[i],anchor=nearest[i];light.setEnabled(!!anchor&&meshes.length>0);
      if(!anchor)continue;
      if(light.includedOnlyMeshes.length!==meshes.length||meshes.some((m,j)=>m!==light.includedOnlyMeshes[j]))light.includedOnlyMeshes=meshes;
      light.position.set(anchor.x,anchor.y-.1,anchor.z);light.intensity=.9*Math.min(1,Math.max(0,(35-Math.hypot(anchor.x-p.x,anchor.y-p.y,anchor.z-p.z))/10));
    }
  });scope.onDispose(()=>core.scene.onBeforeRenderObservable.remove(observer));
  return {getSnapshot(){return {lamps:baked.lamps,groups:baked.groups,maxGroup:baked.maxGroup,buildings:baked.buildings,night,bloom,liveLights:lights.filter(l=>l.isEnabled()).length,stopped};}};
},test:{durationSeconds:8,setup({api,report}){return()=>{const s=api.getSnapshot();report({lamps:s.lamps,groups:s.groups,maxGroup:s.maxGroup,buildings:s.buildings,night:s.night,liveLights:s.liveLights,bloom:Number(s.bloom)});};}}});
