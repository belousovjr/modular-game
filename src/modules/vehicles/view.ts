import '@babylonjs/loaders/glTF/index.js';
import {LoadAssetContainerAsync} from '@babylonjs/core/Loading/sceneLoader.js';
import {TransformNode} from '@babylonjs/core/Meshes/transformNode.js';
import {PBRMaterial} from '@babylonjs/core/Materials/PBR/pbrMaterial.js';
import {Texture} from '@babylonjs/core/Materials/Textures/texture.js';
import manifest from '../../../public/models/car/manifest.json' with {type:'json'};
import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {Quaternion,Vector3} from '@babylonjs/core/Maths/math.vector.js';
import type {Scene} from '@babylonjs/core/scene.js';
import type {Scope} from '../../core/modules.ts';
import type {geometryModule} from '../geometry/index.ts';
import type {VehicleSnapshot} from './headless.ts';

async function loadCar(scene: Scene, scope: Scope, signal: AbortSignal) {
  const response=await fetch(`${import.meta.env.BASE_URL}models/car/car.glb`,{signal});
  if (!response.ok) throw new Error(`Car HTTP ${response.status}`);
  const bytes=new Uint8Array(await response.arrayBuffer());
  if (signal.aborted) return;
  const container=await LoadAssetContainerAsync(bytes,scene,{pluginExtension:'.glb'});
  if (signal.aborted) { container.dispose(); return; }
  scope.onDispose(()=>container.dispose());
  const detail=new Texture(`${import.meta.env.BASE_URL}models/car/detail.png`,scene,false,false);
  scope.onDispose(()=>detail.dispose());
  detail.coordinatesIndex=1;
  for (const material of container.materials) if (material instanceof PBRMaterial && material.name==='car/textured') {
    material.detailMap.texture=detail;
    material.detailMap.isEnabled=true;
    material.detailMap.diffuseBlendLevel=.24;
    material.detailMap.bumpLevel=0;
    material.detailMap.roughnessBlendLevel=.15;
  }
  return container;
}

function sameComponents(a:readonly number[],b:readonly number[]){
  return a.every((value,index)=>value===b[index]);
}

export function createCarView(scene:Scene,geometry:ReturnType<typeof geometryModule.setup>,scope:Scope){
  const root=new TransformNode('vehicle/car/0',scene);root.rotationQuaternion=Quaternion.Identity();scope.onDispose(()=>root.dispose());
  const controller=new AbortController();let stopped=false,status='loading',error='';
  scope.onDispose(()=>{stopped=true;controller.abort();});
  let left:TransformNode|undefined,right:TransformNode|undefined,steering:TransformNode|undefined;
  const wheels:{node:TransformNode;rotation:Quaternion}[]=[];
  let previous:VehicleSnapshot|undefined;
  const ready=(async()=>{
    const container=await loadCar(scene,scope,controller.signal);if(!container||stopped)return;
    container.addAllToScene();
    for(const node of container.rootNodes)node.parent=root;
    const nodes=root.getDescendants().filter((n):n is TransformNode=>n instanceof TransformNode);
    left=nodes.find(n=>n.name==='door/left');right=nodes.find(n=>n.name==='door/right');steering=nodes.find(n=>n.name==='steering');
    if(nodes.filter(n=>n.name==='door/left').length!==1||nodes.filter(n=>n.name==='door/right').length!==1)throw new Error('Exterior car door nodes must be unique');
    if(!left||!right||!steering)throw new Error('Car has no functional door/steering nodes');
    for(const axle of ['front','rear'])for(const side of ['left','right']){
      const node=nodes.find(n=>n.name===`wheel/${axle}/${side}`);if(!node)throw new Error('Missing wheel');
      node.computeWorldMatrix(true);node.setParent(null);wheels.push({node,rotation:(root.rotationQuaternion??Quaternion.Identity()).conjugate().multiply(node.rotationQuaternion??Quaternion.FromEulerVector(node.rotation))});
    }
    root.scaling.y=1.04; // Extra cabin clearance; detached wheels retain their authored shape.
    const meshes=container.meshes.filter((m):m is Mesh=>m instanceof Mesh&&m.getTotalVertices()>0);
    for(const mesh of meshes){mesh.isPickable=false;mesh.metadata={...mesh.metadata,shadowNearOnly:true,shadowStaticMaterial:mesh.material?.name==='car/textured',shadowCaster:mesh.material?.name!=='car/glass'};}
    geometry.registerMeshes(meshes,scope);status='ready';previous=undefined;
  })().catch((e:unknown)=>{if(!stopped){status='error';error=e instanceof Error?e.message:String(e);root.metadata={assetStatus:status,error};}});
  return {ready,status:()=>({state:status,error}),render(s:VehicleSnapshot){
    if(stopped)return;
    const camera=scene.activeCamera;const visible=!camera||Math.hypot(camera.globalPosition.x-s.position[0],camera.globalPosition.y-s.position[1],camera.globalPosition.z-s.position[2])<180;
    if(!previous||root.isEnabled()!==visible){root.setEnabled(visible);for(const w of wheels)w.node.setEnabled(visible);}
    if(!previous||!sameComponents(s.position,previous.position))root.position.set(s.position[0],s.position[1],s.position[2]);
    if(!previous||!sameComponents(s.rotation,previous.rotation))root.rotationQuaternion?.copyFromFloats(s.rotation[0],s.rotation[1],s.rotation[2],s.rotation[3]);
    if(left&&s.leftDoor!==previous?.leftDoor)left.rotationQuaternion=Quaternion.RotationAxis(Vector3.Up(),-s.leftDoor);
    if(right&&s.rightDoor!==previous?.rightDoor)right.rotationQuaternion=Quaternion.RotationAxis(Vector3.Up(),s.rightDoor);
    if(steering&&s.steering!==previous?.steering)steering.rotationQuaternion=Quaternion.RotationAxis(Vector3.Forward(),s.steering*2.5);
    for(const [i,w]of wheels.entries()){
      const p=s.wheels[i],last=previous?.wheels[i];
      if(!last||!sameComponents(p.position,last.position))w.node.position.set(p.position[0],p.position[1],p.position[2]);
      if(!last||!sameComponents(p.rotation,last.rotation))w.node.rotationQuaternion=Quaternion.FromArray(p.rotation).multiply(w.rotation);
    }
    if(!previous||s.phase!==previous.phase||s.speed!==previous.speed||s.leftDoor!==previous.leftDoor||s.rightDoor!==previous.rightDoor){
      root.metadata={assetStatus:status,triangles:manifest.triangles,phase:s.phase,speed:s.speed,leftDoor:s.leftDoor,rightDoor:s.rightDoor};
    }
    previous=s;
  }};
}

export function createTrafficCarAssets(scene: Scene,scope: Scope) {
  const controller=new AbortController();
  scope.onDispose(()=>controller.abort());
  let container: Awaited<ReturnType<typeof loadCar>>;
  let pending: Promise<void>|undefined;
  let error='';
  return {
    load() {
      pending??=loadCar(scene,scope,controller.signal).then(value=>{container=value;})
        .catch((cause: unknown)=>{if(!controller.signal.aborted)error=cause instanceof Error?cause.message:String(cause);});
    },
    status:()=>error,
    create(owner: Scope,id: string) {
      if (!container || controller.signal.aborted || error) return;
      const root=new TransformNode(id,scene);
      root.rotationQuaternion=Quaternion.Identity();
      owner.onDispose(()=>root.dispose());
      const entries=container.instantiateModelsToScene(name=>name,false,{doNotInstantiate:true});
      owner.onDispose(()=>entries.dispose());
      for(const node of entries.rootNodes)node.parent=root;
      const wheels=root.getDescendants().flatMap(node=>{
        if (!(node instanceof TransformNode)||!node.name.startsWith('wheel/')) return [];
        return [{node,front:node.name.startsWith('wheel/front/'),
          rotation:node.rotationQuaternion?.clone()??Quaternion.FromEulerVector(node.rotation)}];
      });
      if (wheels.length!==4) { error='GLB: не найдены четыре колеса фоновой машины'; return; }
      for (const mesh of root.getChildMeshes()) {
        mesh.isPickable=false;
        mesh.metadata={...mesh.metadata,shadowCaster:false};
      }
      return (pose: { point: readonly [number,number,number]; yaw: number; steering: number; wheelDistance: number; pitch: number })=>{
        root.position.set(pose.point[0],pose.point[1],pose.point[2]);
        root.rotationQuaternion?.copyFrom(Quaternion.FromEulerAngles(pose.pitch,pose.yaw,0));
        const spin=Quaternion.RotationAxis(Vector3.Right(),pose.wheelDistance/.43);
        const steer=Quaternion.RotationAxis(Vector3.Up(),-pose.steering);
        for (const {node,front,rotation} of wheels)
          node.rotationQuaternion=(front?steer.multiply(spin):spin).multiply(rotation);
      };
    },
  };
}
