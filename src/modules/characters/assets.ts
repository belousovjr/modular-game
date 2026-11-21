import '@babylonjs/loaders/glTF/index.js';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { SerializationHelper } from '@babylonjs/core/Misc/decorators.serialization.js';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
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
import {bodies,defaultAppearance,hairColors,skinColors,type Appearance,type Body} from './appearance.ts';
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
  let stopped = false;
  const sources=new Map<Body,AssetContainer>();
  const palette=new WeakMap<PBRMaterial,Map<string,PBRMaterial>>();
  let status: AssetStatus = Object.freeze({ state:'loading', error:null });
  const listeners = new Set<() => void>();
  owner.onDispose(() => {
    stopped=true;controller.abort();listeners.clear();
    for(const source of sources.values())source.dispose();
    sources.clear();
  });
  async function load(body:Body) {
    const response=await fetch(`${import.meta.env?.BASE_URL??'/'}models/human/${body}.glb`,{signal:controller.signal});
    if(!response.ok)throw new Error(`GLB ${body}: HTTP ${response.status}`);
    const bytes=new Uint8Array(await response.arrayBuffer());
    if(stopped||controller.signal.aborted)return;
    const container=await LoadAssetContainerAsync(bytes,scene,{pluginExtension:'.glb'});
    if(stopped||controller.signal.aborted){container.dispose();return;}
    sources.set(body,container);
    for(const group of container.animationGroups)group.stop();
    for(const name of manifest.runtimeClips)if(!container.animationGroups.some(group=>group.name===name))
      throw new Error(`GLB ${body}: missing ${name}`);
  }
  const ready=Promise.all([load('male'),load('female')]).then(()=>{
    if(stopped)return;
    status=Object.freeze({state:'ready',error:null});
    for(const listener of listeners)listener();
  }).catch((error:unknown)=>{
    controller.abort();
    for(const source of sources.values())source.dispose();
    sources.clear();
    if(stopped)return;
    status=Object.freeze({state:'error',error:error instanceof Error?error.message:String(error)});
    for(const listener of listeners)listener();
  });
  function tinted(material:PBRMaterial,color:string) {
    let variants=palette.get(material);
    if(!variants){variants=new Map();palette.set(material,variants);}
    let result=variants.get(color);
    if(!result){
      const name=`character-${material.name}-${color}`;
      result=SerializationHelper.Instanciate(()=>new PBRMaterial(name,scene),material);
      result.id=result.name=name;
      result.albedoColor=Color3.FromHexString(color).toLinearSpace();
      variants.set(color,result);
      const owned=result;
      owner.onDispose(()=>owned.dispose());
    }
    return result;
  }
  const reportError=(error:unknown)=>{if(!stopped){status=Object.freeze({state:'error',error:error instanceof Error?error.message:String(error)});for(const listener of listeners)listener();}};
  return { ready, reportError, createShadowProxy, shouldAnimate, getContainer:(body:Body)=>status.state==='ready'?sources.get(body):undefined,tinted, getStatus:()=>status, subscribe(listener:()=>void) { if(stopped)return ()=>{};listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

export function createAvatar(scene: Scene, geometry: ReturnType<typeof geometryModule.setup>, assets: ReturnType<typeof createCharacterAssets>, scope: Scope, initialAppearance:Appearance=defaultAppearance) {
  let disposed = false, entries: InstantiatedEntries | null = null, active: AnimationGroup | undefined;
  const root = new TransformNode('character/local-player',scene);root.rotationQuaternion=Quaternion.Identity();
  const vehicleTurnOffset=Quaternion.Identity(),identity=Quaternion.Identity();
  const clips=new Map<string,AnimationGroup>(),playing=new Set<AnimationGroup>();
  let fade=1,appearance=initialAppearance;
  let modelScope:ReturnType<typeof createScope>|undefined;
  let loadedBody:Body|undefined;
  const paused:AnimationGroup[]=[];
  const visualMeshes:Mesh[]=[];
  const originalMaterials=new Map<Mesh,PBRMaterial>();
  const selected=(mesh:Mesh)=>{
    const part=mesh.name.slice(mesh.name.lastIndexOf('/')+1);
    return !part.startsWith('part-') || (part==='part-Beard'?appearance.beard:part===`part-${appearance.hair}`);
  };
  function updateParts(){
    for(const mesh of visualMeshes){
      const original=originalMaterials.get(mesh);
      if(original){
        const color=original.name==='skin'?skinColors[appearance.skin].color:
          original.name==='hair'||original.name==='brows'?hairColors[appearance.hairColor].color:undefined;
        const material=color?assets.tinted(original,color):original;
        if(mesh.material!==material){
          geometry.setMeshFade(mesh,0,1);
          mesh.material=material;
        }
      }
    }
    updateCoverage();
  }
  function updateCoverage(){
    for(const mesh of visualMeshes){
      const enabled=fade>0&&selected(mesh);
      mesh.setEnabled(enabled);
      geometry.setMeshFade(mesh,0,enabled?fade:1);
    }
  }
  function setFade(coverage: number) {
    if (fade===coverage || disposed) return;
    fade=coverage;
    updateCoverage();
    shadow.setEnabled(fade>.5);
  }
  root.metadata = { assetStatus:'loading' };
  scope.onDispose(() => { disposed=true; modelScope?.dispose();entries=null;clips.clear();playing.clear();paused.length=0;root.dispose(); });
  const shadow=assets.createShadowProxy(root,scope);
  geometry.registerMeshes([shadow],scope);
  const loading=createScope();scope.onDispose(loading.dispose);
  if (!assets.getContainer(appearance.body)) {
    const capsule=MeshBuilder.CreateCapsule('character/loading',{height:1.8,radius:.28,tessellation:8},scene);
    loading.onDispose(()=>capsule.dispose());capsule.metadata={shadowCaster:false};capsule.parent=root;capsule.position.y=.9;
    const material=new StandardMaterial('character-loading',scene);loading.onDispose(()=>material.dispose());material.diffuseColor=Color3.FromHexString('#7e929f');capsule.material=material;
    geometry.registerMeshes([capsule],loading);
    visualMeshes.push(capsule);
  }
  function load(){
    if(disposed||loadedBody===appearance.body)return;
    const container=assets.getContainer(appearance.body);
    if(!container)return;
    modelScope?.dispose();
    entries=null;active=undefined;clips.clear();playing.clear();paused.length=0;originalMaterials.clear();
    const model=createScope();
    modelScope=model;
    try {
      entries=container.instantiateModelsToScene(name=>`human/${name}`,false,{doNotInstantiate:true});
      const owned=entries;
      model.onDispose(()=>owned.dispose());
      const meshes=entries.rootNodes.flatMap(node=>node.getChildMeshes(false)).filter((mesh):mesh is Mesh=>mesh instanceof Mesh && mesh.getTotalVertices()>0);
      for(const mesh of meshes){
        mesh.isPickable=false;mesh.metadata={...mesh.metadata,shadowCaster:false};
        if(mesh.material instanceof PBRMaterial)originalMaterials.set(mesh,mesh.material);
      }
      const visual=new TransformNode('human-visual',scene);model.onDispose(()=>visual.dispose(true));
      for(const node of entries.rootNodes){node.parent=visual;node.setEnabled(true);}
      const {minY,maxY}=bodies[appearance.body];
      const scale=1.8/(maxY-minY);
      visual.scaling.setAll(scale);visual.position.y=-minY*scale;visual.parent=root;
      geometry.registerMeshes(meshes,model);
      for(const group of entries.animationGroups) { group.stop();group.enableBlending=false;
        clips.set(group.name.slice(group.name.lastIndexOf('/')+1),group);
        if(!group.name.endsWith('_Loop'))for(const track of group.targetedAnimations)track.animation.loopMode=Animation.ANIMATIONLOOPMODE_CONSTANT;
      }
      const idle=entries.animationGroups.find(group=>group.name.endsWith('/Idle_Loop'));
      if(idle&&root.isEnabled()) { idle.enableBlending=false;startAvatarClip(idle,1);active=idle;playing.add(idle); }
      loading.dispose();
      visualMeshes.splice(0,visualMeshes.length,...meshes);
      loadedBody=appearance.body;
      updateParts();
      root.metadata={assetStatus:'ready',joints:manifest.joints};
    } catch(error) {
      model.dispose();entries=null;visualMeshes.length=0;assets.reportError(error);
      root.metadata={assetStatus:'error',error:error instanceof Error?error.message:String(error)};
    }
  }
  if(assets.getContainer(appearance.body))load();else void assets.ready.then(load);
  function setAppearance(next:Appearance){
    if(disposed)return;
    appearance=next;
    if(loadedBody!==next.body)load();
    else updateParts();
  }
  const sampleHeight=createDisplayHeight();
  const sampleGroundMotion=createGroundMotion();
  let previous: CharacterSnapshot | null = null, speed=0;
  function pauseAnimations(){
    for(const group of playing)if(group.isPlaying){group.pause();paused.push(group);}
    root.metadata.animationCulled=true;
  }
  const draw=(s: CharacterSnapshot, displayY?:number) => {
    if (disposed) return;
    root.name=`character/${s.id}`;
    const before=previous?.id===s.id?previous:null,deltaMs=scene.getEngine().getDeltaTime();
    const targetHeight=displayY??sampleHeight(s,deltaMs,!before);
    const x=s.x,z=s.z;
    const dx=x-root.position.x,dy=targetHeight-root.position.y,dz=z-root.position.z;
    const gap=Math.hypot(dx,dy,dz);
    if(displayY===undefined&&before&&isGroundMotion(s)&&gap>.001&&gap<.35){
      const blend=1-Math.exp(-deltaMs/45);
      root.position.set(root.position.x+dx*blend,root.position.y+dy*blend,root.position.z+dz*blend);
    }else root.position.set(x,targetHeight,z);
    if (!before) speed=0;
    else if (s.tick>before.tick) speed=Math.hypot(s.x-before.x,s.z-before.z)*60/(s.tick-before.tick);
    previous=s;
    if (!entries){root.rotationQuaternion?.copyFrom(Quaternion.FromEulerAngles(0,s.yaw,0));return;}
    const onGround=isGroundMotion(s);
    const wasOnGround=!!before&&isGroundMotion(before);
    const gait=sampleGroundMotion(s,speed,deltaMs,!onGround||!wasOnGround);
    if(!assets.shouldAnimate(s.x,s.y,s.z)){
      pauseAnimations();
      if (root.rotationQuaternion) {
        const target=s.vehicleRotation?Quaternion.FromArray(s.vehicleRotation):Quaternion.FromEulerAngles(0,s.yaw,0);
        if (before) smoothCharacterRotation(root.rotationQuaternion,target,deltaMs,root.rotationQuaternion);
        else root.rotationQuaternion.copyFrom(target);
      }
      return;
    }
    for(const group of paused)group.restart();paused.length=0;root.metadata.animationCulled=false;
    const name=selectAnimation(s,onGround?gait:s);
    const next=clips.get(name);
    if (!next) return;
    if (next!==active) {
      if(!next.isPlaying) {
        startAvatarClip(next,active?0:1);
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
  return Object.assign(draw,{setFade,setAppearance});
}

export function startAvatarClip(group:AnimationGroup,weight:number) {
  group.start(true);
  group.weight=weight;
  // Only the first clip applies its pose immediately. Transitions use weighted playback.
  if(weight===1)group.goToFrame(group.from);
}

type GroundGait=Pick<CharacterSnapshot,'moving'|'running'|'boosted'>;
const FALL_POSE_TICKS=4;

function usesGroundPose(snapshot:CharacterSnapshot) {
  return snapshot.grounded||(snapshot.verticalSpeed<=0&&snapshot.airborneTicks<FALL_POSE_TICKS);
}

function isGroundMotion(snapshot:CharacterSnapshot) {
  return usesGroundPose(snapshot)&&snapshot.mode==='walk'&&(!snapshot.vehicleId||snapshot.vehicleAnimation==='approaching');
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
  if(!usesGroundPose(s))return s.verticalSpeed>0&&s.airborneTicks<7?'Jump_Start':'Jump_Loop';
  if(s.grounded&&s.airborneTicks>=FALL_POSE_TICKS&&s.tick-s.landedTick<9)return 'Jump_Land';
  return !gait.moving?'Idle_Loop':gait.boosted?'Sprint_Loop':gait.running?'Jog_Fwd_Loop':'Walk_Loop';
}

export function smoothYaw(current: number, target: number, deltaMs: number) {
  const difference=Math.atan2(Math.sin(target-current),Math.cos(target-current));
  return current+difference*(1-Math.exp(-Math.max(0,deltaMs)/60));
}


export function smoothCharacterRotation(current:Quaternion,target:Quaternion,deltaMs:number,result:Quaternion){
  Quaternion.SlerpToRef(current,target,1-Math.exp(-Math.max(0,deltaMs)/60),result);
}
