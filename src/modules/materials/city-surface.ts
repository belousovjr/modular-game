import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { MaterialDefines } from '@babylonjs/core/Materials/materialDefines.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer.js';

// Adapted from the neighbouring project's inexpensive water normals: no reflection render targets.
export class WaterSurface extends MaterialPluginBase {
  constructor(material:Material) {super(material,'CityWater',210,{},true,true);this.doNotSerialize=true;}
  getClassName(){return 'CityWater';}
  getUniforms(){return {ubo:[{name:'waterTime',size:1,type:'float'}]};}
  bindForSubMesh(buffer:UniformBuffer){buffer.updateFloat('waterTime',performance.now()*.001);}
  getCustomCode(type:string){return type==='fragment'?{CUSTOM_FRAGMENT_BEFORE_LIGHTS:`
    float waterDetail=1.-smoothstep(40.,180.,length(vEyePosition.xyz-vPositionW));
    vec2 slope=vec2(sin(dot(vPositionW.xz,vec2(1.7,.8))+waterTime*1.1),sin(dot(vPositionW.xz,vec2(-.6,2.3))-waterTime*.8));
    normalW=normalize(normalW+vec3(slope.x,0.,slope.y)*(.035*waterDetail));
  `}:null;}
}
export class CityFacade extends MaterialPluginBase {
  constructor(material:Material){super(material,'CityFacade',220,{FITTED_SURFACE_UV:false},true,true);this.doNotSerialize=true;}
  getClassName(){return 'CityFacade';}
  getAttributes(attributes:string[]){for(const name of ['uv','normal'])if(!attributes.includes(name))attributes.push(name);}
  prepareDefinesBeforeAttributes(defines:MaterialDefines,_scene:Scene,mesh:AbstractMesh){defines.FITTED_SURFACE_UV=mesh.metadata?.fittedUV===true;}
  getCustomCode(type:string):Record<string,string>|null{
    if(type==='vertex')return {
      CUSTOM_VERTEX_DEFINITIONS:`
        #ifndef UV1
        attribute vec2 uv;
        #endif
        #if !defined(NORMAL) && !defined(CITY_NORMAL_DECLARED)
        #define CITY_NORMAL_DECLARED
        attribute vec3 normal;
        #endif
        varying vec2 vCityUV;
      `,
      CUSTOM_VERTEX_MAIN_END:`
        #ifdef FITTED_SURFACE_UV
        vCityUV=uv;
        #else
        vec3 citySize=vec3(length(finalWorld[0].xyz),length(finalWorld[1].xyz),length(finalWorld[2].xyz));
        float cityU=abs(normal.x)>abs(normal.z)?positionUpdated.z:positionUpdated.x;
        float cityWidth=abs(normal.x)>abs(normal.z)?citySize.z:citySize.x;
        vCityUV=vec2((cityU+.5)*max(1.,floor(cityWidth/2.8+.5)),(positionUpdated.y+.5)*max(1.,floor(citySize.y/3.5+.5)));
        #endif
      `,
    };
    return type==='fragment'?{
      CUSTOM_FRAGMENT_DEFINITIONS:'varying vec2 vCityUV;',
      CUSTOM_FRAGMENT_BEFORE_LIGHTS:`
        if(vCityUV.x<-.5){
          if(vCityUV.x<-2.5)baseColor.rgb*=1.12;
          else if(vCityUV.x<-1.5)diffuseColor=vec3(.9);
          else baseColor.rgb*=.67;
        } else if(abs(normalW.y)<.4){
          vec2 cell=vCityUV;
          vec2 uv=abs(fract(cell)-.5);
          vec2 edge=max(fwidth(cell),vec2(.002));
          float window=(1.-smoothstep(.32-edge.x,.32+edge.x,uv.x))*(1.-smoothstep(.34-edge.y,.34+edge.y,uv.y));
          baseColor.rgb=mix(baseColor.rgb,vec3(.16,.23,.27),window*.8);
        }
      `,
    }:null;
  }
}
