import {MaterialPluginBase} from '@babylonjs/core/Materials/materialPluginBase.js';
import type {Material} from '@babylonjs/core/Materials/material.js';
import type {AbstractEngine} from '@babylonjs/core/Engines/abstractEngine.js';
import type {SubMesh} from '@babylonjs/core/Meshes/subMesh.js';
import type {Scene} from '@babylonjs/core/scene.js';
import type {UniformBuffer} from '@babylonjs/core/Materials/uniformBuffer.js';

export interface Doorway {
  readonly x:number; readonly y:number; readonly z:number;
  readonly tx:number; readonly tz:number; readonly width:number; readonly height:number;
}

export class DoorwayCut extends MaterialPluginBase {
  doorway: Doorway | null = null;
  constructor(material: Material) {
    super(material, 'DoorwayCut', 205, {}, true, false, true);
    this.registerForExtraEvents=true;
    this._enable(true);
  }
  getClassName() { return 'DoorwayCut'; }
  getUniforms() {
    return {externalUniforms:['doorwayCenter','doorwayAxis']};
  }
  hardBindForSubMesh(_buffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh) {
    const door=this.doorway;
    subMesh.effect?.setFloat4('doorwayCenter',door?.x??0,door?.y??0,door?.z??0,door?.height??0);
    subMesh.effect?.setFloat4('doorwayAxis',door?.tx??0,door?.tz??0,(door?.width??0)/2,0);
  }
  getCustomCode(type: string) {
    return type==='fragment'?{CUSTOM_FRAGMENT_DEFINITIONS:'uniform vec4 doorwayCenter; uniform vec4 doorwayAxis;',CUSTOM_FRAGMENT_BEFORE_LIGHTS:`
      if(doorwayCenter.w>0.){
        vec3 doorLocal=vPositionW-doorwayCenter.xyz;
        if(doorLocal.y>.015 && doorLocal.y<doorwayCenter.w
          && abs(dot(doorLocal.xz,doorwayAxis.xy))<doorwayAxis.z
          && abs(dot(doorLocal.xz,vec2(-doorwayAxis.y,doorwayAxis.x)))<.95)discard;
      }`}:null;
  }
}
