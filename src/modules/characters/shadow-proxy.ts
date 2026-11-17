import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { CreateSphereVertexData } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from '../../core/modules.ts';

export function createCharacterShadowSource(scene:Scene,owner:Scope){
  const height=.60;
  const source=new Mesh('character/shadow-source',scene);
  owner.onDispose(()=>source.dispose());
  CreateSphereVertexData({
    diameterX:1.40,diameterY:height,diameterZ:1.36,segments:2,dedupTopBottomIndices:true,
  }).applyToMesh(source);
  source.setEnabled(false);
  const material=new StandardMaterial('character/shadow-only',scene);
  owner.onDispose(()=>material.dispose());
  source.material=material;
  return (parent:TransformNode,scope:Scope)=>{
    const proxy=source.clone('character/shadow-proxy',parent);
    scope.onDispose(()=>proxy.dispose());
    proxy.setEnabled(true);
    proxy.position.y=height/2-.02;
    // Explicit shadow render lists ignore layer masks; ordinary cameras never draw this caster.
    proxy.layerMask=0;
    proxy.isPickable=false;
    proxy.metadata={characterShadow:true,shadowNearOnly:true,shadowFeather:.87};
    return proxy;
  };
}
