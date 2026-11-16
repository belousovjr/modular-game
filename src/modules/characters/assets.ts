import '@babylonjs/loaders/glTF/index.js';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core/assetContainer.js';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup.js';
import type { Scope } from '../../core/modules.ts';
import { createScope } from '../../core/scope.ts';
import type { geometryModule } from '../geometry/index.ts';
import type { CharacterSnapshot } from './headless.ts';
import {createCharacterShadowSource} from './shadow-proxy.ts';
import manifest from '../../../public/models/human/manifest.json' with { type: 'json' };

export interface AssetStatus { readonly state: 'loading' | 'ready' | 'error'; readonly error: string | null }
export function createCharacterAssets(scene: Scene, owner: Scope) {
  const createShadowProxy=createCharacterShadowSource(scene,owner);
  const controller = new AbortController();
  let stopped = false, source: AssetContainer | null = null;
  let status: AssetStatus = Object.freeze({ state:'loading', error:null });
  const listeners = new Set<() => void>();
  owner.onDispose(() => { stopped = true; controller.abort(); listeners.clear(); source?.dispose(); source=null; });
  const ready = (async () => {
    const response = await fetch(`${import.meta.env.BASE_URL}models/human/character.glb`,{ signal:controller.signal });
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
  return { ready, reportError, createShadowProxy, getContainer:()=>source, getStatus:()=>status, subscribe(listener:()=>void) { if(stopped)return ()=>{};listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

export function createAvatar(scene: Scene, geometry: ReturnType<typeof geometryModule.setup>, assets: ReturnType<typeof createCharacterAssets>, scope: Scope) {
  let disposed = false, entries: InstantiatedEntries | null = null, active: AnimationGroup | undefined;
  const root = new TransformNode('character/local-player',scene);
  root.metadata = { assetStatus:'loading' };
  scope.onDispose(() => { disposed=true; entries?.dispose(); entries=null; root.dispose(); });
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
      for(const group of entries.animationGroups) { group.stop();group.enableBlending=false; }
      const idle=entries.animationGroups.find(group=>group.name.endsWith('/Idle_Loop'));
      if(idle) { idle.enableBlending=false;idle.start(true);idle.weight=1;idle.goToFrame(idle.from);idle.enableBlending=false;active=idle; }
      loading.dispose();root.metadata={assetStatus:'ready',triangles:manifest.triangles,drawCalls:manifest.primitives,joints:manifest.joints};
    } catch(error) {
      entries?.dispose();entries=null;assets.reportError(error);root.metadata={assetStatus:'error',error:error instanceof Error?error.message:String(error)};
    }
  };
  const existing=assets.getContainer();if(existing)load(existing);else void assets.ready.then(load);
  let previous: CharacterSnapshot | null = null, speed=0;
  return (s: CharacterSnapshot) => {
    if (disposed) return;
    root.position.set(s.x,s.y,s.z);
    root.rotation.y=previous?smoothYaw(root.rotation.y,s.yaw,scene.getEngine().getDeltaTime()):s.yaw;
    if (previous && s.tick>previous.tick) speed=Math.hypot(s.x-previous.x,s.z-previous.z)*60/(s.tick-previous.tick);
    previous=s;
    if (!entries) return;
    const name=selectAnimation(s);
    const next=entries.animationGroups.find(group=>group.name.endsWith('/'+name));
    if (!next) return;
    if (next!==active) { if(!next.isPlaying) { next.start(true);next.weight=0; } active=next; }
    blendAnimations(entries.animationGroups,active,scene.getEngine().getDeltaTime());
    root.metadata.animation=name;
    active.speedRatio=!name.startsWith('Jump_') && s.moving?Math.max(.65,Math.min(s.running?1.4:1.2,speed/(s.running?7:1.6))):1;
  };
}

export function blendAnimations(groups: readonly AnimationGroup[], active: AnimationGroup, deltaMs: number) {
  const blend=1-Math.exp(-Math.min(100,deltaMs)/50);
  for(const group of groups) {
    if(!group.isPlaying) continue;
    const weight=group.weight+(Number(group===active)-group.weight)*blend;
    group.weight=weight;
    if(group!==active && weight<.005) group.stop();
  }
}

export function selectAnimation(s: CharacterSnapshot) {
  return !s.grounded?(s.airborneTicks<7?'Jump_Start':'Jump_Loop'):s.tick-s.landedTick<9?'Jump_Land':!s.moving?'Idle_Loop':s.running?'Sprint_Loop':'Walk_Loop';
}

export function smoothYaw(current: number, target: number, deltaMs: number) {
  const difference=Math.atan2(Math.sin(target-current),Math.cos(target-current));
  return current+difference*(1-Math.exp(-Math.max(0,deltaMs)/60));
}
