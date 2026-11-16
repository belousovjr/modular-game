import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from '../../core/modules.ts';

export function createCharacterShadowSource(scene:Scene,owner:Scope){
  const source=MeshBuilder.CreateCapsule('character/shadow-source',{height:1.65,radius:.24,tessellation:8,subdivisions:1,topCapSubdivisions:2,bottomCapSubdivisions:2},scene);
  owner.onDispose(()=>source.dispose());
  source.setEnabled(false);
  const material=new StandardMaterial('character/shadow-only',scene);
  owner.onDispose(()=>material.dispose());
  source.material=material;
  return (parent:TransformNode,scope:Scope)=>{
    const proxy=source.clone('character/shadow-proxy',parent);
    scope.onDispose(()=>proxy.dispose());
    proxy.setEnabled(true);
    proxy.scaling.set(1.5,1.05/1.65,1.2);
    proxy.position.y=.525;
    // Explicit shadow render lists ignore layer masks; ordinary cameras never draw this caster.
    proxy.layerMask=0;
    proxy.isPickable=false;
    proxy.metadata={characterShadow:true};
    return proxy;
  };
}
