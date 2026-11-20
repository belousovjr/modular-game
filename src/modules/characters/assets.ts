import '@babylonjs/loaders/glTF/index.js';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Frustum } from '@babylonjs/core/Maths/math.frustum.js';
import { Quaternion, Vector3, Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core/assetContainer.js';
import { Animation } from '@babylonjs/core/Animations/animation.js';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js';
import type { Scope } from '../../core/modules.ts';
import { createScope } from '../../core/scope.ts';
import type { geometryModule } from '../geometry/index.ts';
import {LOCOMOTION_SPEEDS, type CharacterSnapshot} from './headless.ts';
import {createDisplayHeight} from './height-presentation.ts';
import {createCharacterShadowSource} from './shadow-proxy.ts';
import manifest from '../../../public/models/human/manifest.json' with { type: 'json' };

export interface AssetStatus { readonly state: 'loading' | 'ready' | 'error'; readonly error: string | null }
export function createCharacterAssets(scene: Scene, owner: Scope) {
  const createShadowProxy=createCharacterShadowSource(scene,owner);
  const frustum=Frustum.GetPlanes(Matrix.Identity()),center=Vector3.Zero();let frustumFrame=-1,frustumCamera=scene.activeCamera;
  const shouldAnimate=(x:number,y:number,z:number)=>{
    const camera=scene.activeCamera;if(!camera)return true;camera.getViewMatrix();
    if(Math.hypot(camera.globalPosition.x-x,camera.globalPosition.y-y,camera.globalPosition.z-z)>120)return false;
    const frame=scene.getEngine().frameId;if(frame!==frustumFrame||camera!==frustumCamera){camera.getProjectionMatrix();Frustum.GetPlanesToRef(camera.getTransformationMatrix(),frustum);frustumFrame=frame;frustumCamera=camera;}
    center.set(x,y+.9,z);return frustum.every(plane=>plane.dotCoordinate(center)>-3);
  };
  const controller = new AbortController();
  let stopped = false, source: AssetContainer | null = null;
  let status: AssetStatus = Object.freeze({ state:'loading', error:null });
  const listeners = new Set<() => void>();
  owner.onDispose(() => { stopped = true; controller.abort(); listeners.clear(); source?.dispose(); source=null; });
  const ready = (async () => {
    const response = await fetch(`${import.meta.env?.BASE_URL??'/'}models/human/character.glb`,{ signal:controller.signal });
    if (!response.ok) throw new Error(`GLB: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (stopped) return null;
    const container = await LoadAssetContainerAsync(bytes,scene,{ pluginExtension:'.glb' });
    if (stopped) { container.dispose(); return null; }
    source = container;
    for (const group of container.animationGroups) group.stop();
    for (const name of manifest.runtimeClips) if (!container.animationGroups.some(group => group.name === name)) throw new Error(`GLB: missing ${name}`);
    for (const material of container.materials) material.name=`character-${material.name}`;
    status = Object.freeze({ state:'ready',error:null });
    for (const listener of listeners) listener();
    return container;
  })().catch((error: unknown) => {
    source?.dispose(); source=null;
    if (!stopped) {
      status = Object.freeze({ state:'error',error:error instanceof Error?error.message:String(error) });
      for (const listener of listeners) listener();
    }
    return null;
  });
  const reportError=(error:unknown)=>{if(!stopped){status=Object.freeze({state:'error',error:error instanceof Error?error.message:String(error)});for(const listener of listeners)listener();}};
  return { ready, reportError, createShadowProxy, shouldAnimate, getContainer:()=>source, getStatus:()=>status, subscribe(listener:()=>void) { if(stopped)return ()=>{};listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

export interface AvatarDrawDistance {readonly show:number;readonly hide:number}
export function createAvatar(scene: Scene, geometry: ReturnType<typeof geometryModule.setup>, assets: ReturnType<typeof createCharacterAssets>, scope: Scope, drawDistance?:AvatarDrawDistance) {
  let disposed = false, entries: InstantiatedEntries | null = null, active: AnimationGroup | undefined;
  const root = new TransformNode('character/local-player',scene);root.rotationQuaternion=Quaternion.Identity();
  const vehicleTurnOffset=Quaternion.Identity(),identity=Quaternion.Identity();
  const clips=new Map<string,AnimationGroup>(),playing=new Set<AnimationGroup>();
  root.metadata = { assetStatus:'loading' };
  if(drawDistance)root.setEnabled(false);
  scope.onDispose(() => { disposed=true; entries?.dispose(); entries=null;clips.clear();playing.clear();root.dispose(); });
  const shadow=assets.createShadowProxy(root,scope);
  geometry.registerMeshes([shadow],scope);
  const loading=createScope();scope.onDispose(loading.dispose);
  if (!assets.getContainer()) {
    const capsule=MeshBuilder.CreateCapsule('character/loading',{height:1.8,radius:.28,tessellation:8},scene);
    loading.onDispose(()=>capsule.dispose());capsule.metadata={shadowCaster:false};capsule.parent=root;capsule.position.y=.9;
    const material=new StandardMaterial('character-loading',scene);loading.onDispose(()=>material.dispose());material.diffuseColor=Color3.FromHexString('#7e929f');capsule.material=material;
    geometry.registerMeshes([capsule],loading);
  }
  const load=(container:AssetContainer | null) => {
    if (disposed || entries) return;
    if (!container) { root.metadata={assetStatus:'error',error:assets.getStatus().error};return; }
    try {
      entries=container.instantiateModelsToScene(name=>`human/${name}`,false,{doNotInstantiate:true});
      const meshes=entries.rootNodes.flatMap(node=>node.getChildMeshes(false)).filter((mesh):mesh is Mesh=>mesh instanceof Mesh && mesh.getTotalVertices()>0);
      const minimum=new Vector3(Infinity,Infinity,Infinity),maximum=new Vector3(-Infinity,-Infinity,-Infinity);
      for(const mesh of meshes) { mesh.computeWorldMatrix(true); const b=mesh.getBoundingInfo().boundingBox;minimum.minimizeInPlace(b.minimumWorld);maximum.maximizeInPlace(b.maximumWorld);mesh.isPickable=false;mesh.metadata={...mesh.metadata,shadowCaster:false}; }
      const height=maximum.y-minimum.y;
      if (!Number.isFinite(height) || height<.1) throw new Error('GLB: invalid human bounds');
      const visual=new TransformNode('human-visual',scene);scope.onDispose(()=>visual.dispose());
      for(const node of entries.rootNodes) { node.parent=visual;node.setEnabled(true); }
      visual.scaling.setAll(1.8/height);visual.position.y=-minimum.y*1.8/height;visual.parent=root;
      geometry.registerMeshes(meshes,scope);
      for(const group of entries.animationGroups) { group.stop();group.enableBlending=false;
        clips.set(group.name.slice(group.name.lastIndexOf('/')+1),group);
        if(!group.name.endsWith('_Loop'))for(const track of group.targetedAnimations)track.animation.loopMode=Animation.ANIMATIONLOOPMODE_CONSTANT;
      }
      const idle=entries.animationGroups.find(group=>group.name.endsWith('/Idle_Loop'));
      if(idle&&root.isEnabled()) { idle.enableBlending=false;idle.start(true);idle.weight=1;idle.goToFrame(idle.from);active=idle;playing.add(idle); }
      loading.dispose();root.metadata={assetStatus:'ready',triangles:manifest.triangles,drawCalls:manifest.primitives,joints:manifest.joints};
    } catch(error) {
      entries?.dispose();entries=null;assets.reportError(error);root.metadata={assetStatus:'error',error:error instanceof Error?error.message:String(error)};
    }
  };
  const existing=assets.getContainer();if(existing)load(existing);else void assets.ready.then(load);
  const sampleHeight=createDisplayHeight();
  const sampleGroundMotion=createGroundMotion();
  let previous: CharacterSnapshot | null = null, speed=0;
  const paused:AnimationGroup[]=[];scope.onDispose(()=>{paused.length=0;});
  function pauseAnimations(){
    for(const group of playing)if(group.isPlaying){group.pause();paused.push(group);}
    root.metadata.animationCulled=true;
  }
  return (s: CharacterSnapshot, displayY?:number) => {
    if (disposed) return;
    root.name=`character/${s.id}`;
    if(drawDistance){
      const camera=scene.activeCamera;
      const wasVisible=root.isEnabled();
      const range=wasVisible?drawDistance.hide:drawDistance.show;
      camera?.getViewMatrix();
      const eye=camera?.globalPosition;
      const visible=!!eye&&Math.hypot(eye.x-s.x,eye.y-(displayY??s.y),eye.z-s.z)<=range;
      if(wasVisible!==visible)root.setEnabled(visible);
      if(!visible){
        if(wasVisible)pauseAnimations();
        previous=null;speed=0;
        return;
      }
    }
    const before=previous,deltaMs=scene.getEngine().getDeltaTime();
    root.position.set(s.x,displayY??sampleHeight(s,deltaMs,!before),s.z);
    if (previous && s.tick>previous.tick) speed=Math.hypot(s.x-previous.x,s.z-previous.z)*60/(s.tick-previous.tick);
    previous=s;
    if (!entries){root.rotationQuaternion?.copyFrom(Quaternion.FromEulerAngles(0,s.yaw,0));return;}
    const onGround=isGroundMotion(s);
    const wasOnGround=!!before&&isGroundMotion(before);
    const gait=sampleGroundMotion(s,speed,deltaMs,!onGround||!wasOnGround);
    if(!assets.shouldAnimate(s.x,s.y,s.z)){
      pauseAnimations();
      if(root.rotationQuaternion)smoothCharacterRotation(root.rotationQuaternion,s.vehicleRotation?Quaternion.FromArray(s.vehicleRotation):Quaternion.FromEulerAngles(0,s.yaw,0),deltaMs,root.rotationQuaternion);
      return;
    }
    for(const group of paused)group.restart();paused.length=0;root.metadata.animationCulled=false;
    const name=selectAnimation(s,onGround?gait:s);
    const next=clips.get(name);
    if (!next) return;
    if (next!==active) {
      if(!next.isPlaying) {
        const ordinal=Number(s.id.slice(s.id.lastIndexOf('/')+1));
        const phase=Number.isSafeInteger(ordinal)&&name.endsWith('_Loop')?ordinal*.61803398875%1:0;
        startAvatarClip(next,active?0:1,phase);
        playing.add(next);
      }
      active=next;
    }
    blendAnimations(playing,active,deltaMs);
    for(const group of playing)if(!group.isPlaying)playing.delete(group);
    const yaw=s.yaw+(s.vehicleAnimation==='entering'?(1-active.weight)*Math.PI/2:0);
    const tilt=s.mode==='fly'&&s.moving
      ?Math.max(.08,Math.min(1.16,(s.boosted?.98:.63)-.46*Math.atan2(s.verticalSpeed,Math.max(1,speed))))
      :0;
    const target=s.vehicleRotation?Quaternion.FromArray(s.vehicleRotation):Quaternion.FromEulerAngles(tilt,yaw,0);
    const current=root.rotationQuaternion;
    if(current){
      if(!before)current.copyFrom(target);
      else if(s.vehicleRotation){
        if(!before.vehicleRotation)target.conjugate().multiplyToRef(current,vehicleTurnOffset);
        smoothCharacterRotation(vehicleTurnOffset,identity,deltaMs,vehicleTurnOffset);
        target.multiplyToRef(vehicleTurnOffset,current);
      }else smoothCharacterRotation(current,target,deltaMs,current);
    }
    root.metadata.animation=name;
    active.speedRatio=name==='Car_Enter'||name==='Car_Exit'?2:
      name==='Sprint_Loop'?Math.max(.9,Math.min(1.65,gait.speed/LOCOMOTION_SPEEDS.sprint*1.5)):
      name==='Jog_Fwd_Loop'?Math.max(.7,Math.min(1.65,gait.speed/4.4)):
      name==='Walk_Loop'?Math.max(.65,Math.min(1.2,gait.speed/1.6)):
      name==='Swim_Fwd_Loop'&&s.boosted?1.35:1;
  };
}

export function startAvatarClip(group:AnimationGroup,weight:number,phase:number) {
  group.start(true);
  group.weight=weight;
  const frame=group.from+(group.to-group.from)*phase;
  // Apply the first pose immediately; subsequent phase changes must respect the crossfade.
  if(weight===1)group.goToFrame(frame);
  else if(phase)group.goToFrame(frame,true);
}

type GroundGait=Pick<CharacterSnapshot,'moving'|'running'|'boosted'>;

function isGroundMotion(snapshot:CharacterSnapshot) {
  return snapshot.grounded&&snapshot.mode==='walk'&&(!snapshot.vehicleId||snapshot.vehicleAnimation==='approaching');
}

export function createGroundMotion(){
  let speed=0,moving=false,running=false,boosted=false;
  return (snapshot:GroundGait,observedSpeed:number,deltaMs:number,reset:boolean)=>{
    if(reset){
      speed=observedSpeed;
      moving=snapshot.moving;
    }else{
      const time=observedSpeed>speed?65:45;
      speed+=(observedSpeed-speed)*(1-Math.exp(-deltaMs/time));
      moving=speed>=(moving ? .18 : .5);
    }
    if(snapshot.moving||reset){running=snapshot.running;boosted=snapshot.boosted;}
    return {speed,moving,running,boosted};
  };
}

export function blendAnimations(groups: Iterable<AnimationGroup>, active: AnimationGroup, deltaMs: number) {
  const blend=1-Math.exp(-Math.min(100,deltaMs)/50);
  for(const group of groups) {
    if(!group.isPlaying) continue;
    const weight=group.weight+(Number(group===active)-group.weight)*blend;
    group.weight=weight;
    if(group!==active && weight<.005) group.stop();
  }
}

export function selectAnimation(s: CharacterSnapshot, gait:GroundGait=s) {
  if(s.vehicleId&&s.vehicleAnimation!=='approaching')return s.vehicleAnimation==='crawling'?'Crawl_Loop':s.vehicleAnimation==='entering'?'Car_Enter':s.vehicleAnimation==='exiting'?'Car_Exit':'Driving_Loop';
  if(s.mode==='fly')return !s.moving?'Fly_Idle_Loop':s.boosted?'Fly_Boost_Loop':'Fly_Loop';
  if(s.mode==='swim')return s.moving?'Swim_Fwd_Loop':'Swim_Idle_Loop';
  if(s.stance==='crouching')return gait.moving?'Crouch_Fwd_Loop':'Crouch_Idle_Loop';
  if(s.stance==='prone')return gait.moving?'Crawl_Fwd_Loop':'Crawl_Idle_Loop';
  return !s.grounded?(s.airborneTicks<7?'Jump_Start':'Jump_Loop'):s.tick-s.landedTick<9?'Jump_Land':!gait.moving?'Idle_Loop':gait.boosted?'Sprint_Loop':gait.running?'Jog_Fwd_Loop':'Walk_Loop';
}

export function smoothYaw(current: number, target: number, deltaMs: number) {
  const difference=Math.atan2(Math.sin(target-current),Math.cos(target-current));
  return current+difference*(1-Math.exp(-Math.max(0,deltaMs)/60));
}


export function smoothCharacterRotation(current:Quaternion,target:Quaternion,deltaMs:number,result:Quaternion){
  Quaternion.SlerpToRef(current,target,1-Math.exp(-Math.max(0,deltaMs)/60),result);
}
