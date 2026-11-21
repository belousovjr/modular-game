import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { surfaces } from './palette.ts';
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
export const FIRST_WINDOW_THRESHOLD = .24;

const doorColor = Color3.FromHexString(surfaces['interior-door'].color).asArray().join(',');
const frameColor = Color3.FromHexString(surfaces['interior-door-frame'].color).asArray().join(',');

export class CityFacade extends MaterialPluginBase {
  constructor(material:Material){super(material,'CityFacade',220,{FITTED_SURFACE_UV:false,RADIAL_FACADE_UV:false,CITY_DOOR_WINDOWS:false,CITY_COARSE_BUILDING:false},true,true);this.doNotSerialize=true;}
  night=0;
  interiorBuilding=0;
  getClassName(){return 'CityFacade';}
  getUniforms(){return {ubo:[{name:'cityNight',size:1,type:'float'},{name:'cityInteriorBuilding',size:1,type:'float'}],
    vertex:'#ifndef UNIFORMBUFFERS\nuniform float cityInteriorBuilding;\n#endif'};}
  bindForSubMesh(buffer:UniformBuffer){buffer.updateFloat('cityNight',this.night);buffer.updateFloat('cityInteriorBuilding',this.interiorBuilding);}
  getAttributes(attributes:string[],_scene:Scene,mesh:AbstractMesh){if(mesh.isVerticesDataPresent('cityDoorWindows'))attributes.push('cityDoorWindows');if(mesh.isVerticesDataPresent('cityBuilding'))attributes.push('cityBuilding');for(const name of ['uv','normal'])if(!attributes.includes(name))attributes.push(name);}
  prepareDefinesBeforeAttributes(defines:MaterialDefines,_scene:Scene,mesh:AbstractMesh){defines.CITY_COARSE_BUILDING=mesh.isVerticesDataPresent('cityBuilding');defines.CITY_DOOR_WINDOWS=mesh.isVerticesDataPresent('cityDoorWindows');defines.FITTED_SURFACE_UV=mesh.metadata?.fittedUV===true;defines.RADIAL_FACADE_UV=mesh.metadata?.radialFacade===true;}
  getCustomCode(type:string):Record<string,string>|null{
    if(type==='vertex')return {
      CUSTOM_VERTEX_DEFINITIONS:`
        #ifdef CITY_COARSE_BUILDING
        attribute float cityBuilding;
        #endif
        #ifndef UV1
        attribute vec2 uv;
        #endif
        #if !defined(NORMAL) && !defined(CITY_NORMAL_DECLARED)
        #define CITY_NORMAL_DECLARED
        attribute vec3 normal;
        #endif
        varying vec2 vCityUV;
        #ifdef CITY_DOOR_WINDOWS
        attribute vec4 cityDoorWindows;
        varying vec4 vCityDoorWindows;
        #endif
      `,
      CUSTOM_VERTEX_MAIN_END:`
        #ifdef CITY_COARSE_BUILDING
        if(cityInteriorBuilding>0. && cityBuilding==cityInteriorBuilding)gl_Position=vec4(2.,2.,2.,1.);
        #endif
        #ifdef CITY_DOOR_WINDOWS
        vCityDoorWindows=cityDoorWindows;
        #endif
        #ifdef RADIAL_FACADE_UV
        vCityUV=vec2(uv.x*32.,(positionUpdated.y+.5)*max(1.,floor(length(finalWorld[1].xyz)/3.5+.5)));
        #elif defined(FITTED_SURFACE_UV)
        vCityUV=uv;
        #else
        // Map whole window cells onto each box wall so corners and crowns end in masonry.
        bool sideWall=abs(normal.x)>.5;
        float span=sideWall?length(finalWorld[2].xyz):length(finalWorld[0].xyz);
        float height=length(finalWorld[1].xyz);
        vec2 grid=max(vec2(1.),floor(vec2(span/2.8,height/3.5)+.5));
        vCityUV=(vec2(sideWall?positionUpdated.z:positionUpdated.x,positionUpdated.y)+.5)*grid;
        // A whole-cell offset keeps the night pattern distinct between tiers.
        vCityUV.y+=floor(max(0.,finalWorld[3].y-height*.5)/3.5);
        #endif
      `,
    };
    return type==='fragment'?{
      CUSTOM_FRAGMENT_DEFINITIONS:`
        varying vec2 vCityUV;
        #ifdef CITY_DOOR_WINDOWS
        varying vec4 vCityDoorWindows;
        #endif
      `,
      CUSTOM_FRAGMENT_BEFORE_FOG:'color.rgb+=cityWindowGlow;',
      CUSTOM_FRAGMENT_BEFORE_LIGHTS:`
        vec3 cityWindowGlow=vec3(0.);
        // Use quad derivatives before branching across facade, trim and roof faces.
        vec2 footprint=max(fwidth(vCityUV),vec2(.002));
        #ifdef NORMAL
        float wallY=abs(normalize(vNormalW).y);
        #else
        float wallY=abs(normalW.y);
        #endif
        #ifdef CITY_FACADE_TRIM
        float role = cityTrimRole;
        #else
        float role = vCityUV.x;
        #endif
        #if defined(CITY_FACADE_TRIM) && defined(CITY_DOOR_WINDOWS)
        if(cityDoorPatch){
          // The prepared entrance is 3 m square, with 25 cm trim and a 12.5 cm meeting stile.
          float edgeDistance=min(cityDoorUV.x,1.-cityDoorUV.x);
          float frame=1.-step(1./12.,min(edgeDistance,1.-cityDoorUV.y));
          float seam=1.-step(1./48.,abs(cityDoorUV.x-.5));
          diffuseColor=mix(vec3(${doorColor}),vec3(${frameColor}),max(frame,seam));
        } else
        #endif
        if(role<-.5){
          if(role<-2.5)baseColor.rgb*=1.21;
          else if(role<-1.5)diffuseColor=vec3(.9);
          else baseColor.rgb*=.67;
        } else if(wallY<.4){
          vec2 cell=vCityUV;
          vec2 uv=abs(fract(cell)-.5);
          float windowResolution=1.-smoothstep(.30,1.0,max(footprint.x,footprint.y));
          vec2 edge=min(footprint,vec2(.095));
          float groundFloor=1.-step(1.,cell.y);
          #if !defined(FITTED_SURFACE_UV) && !defined(RADIAL_FACADE_UV)
          groundFloor=1.-step(1.,vSurfaceMeters.y*(2./3.5));
          #endif
          vec2 opening=mix(vec2(.32,.34),vec2(.40,.39),groundFloor);
          float window=step(0.,cell.y)*(1.-smoothstep(opening.x-edge.x,opening.x+edge.x,uv.x))*(1.-smoothstep(opening.y-edge.y,opening.y+edge.y,uv.y));
          window*=windowResolution;
          #ifdef CITY_DOOR_WINDOWS
          vec2 windowCenter=floor(cell)+.5;
          if(vCityDoorWindows.z>vCityDoorWindows.x &&
             all(greaterThan(windowCenter+opening,vCityDoorWindows.xy)) &&
             all(lessThan(windowCenter-opening,vCityDoorWindows.zw))) window=0.;
          #endif
          float detail=(1.-smoothstep(.04,.16,max(edge.x,edge.y)))*(1.-smoothstep(18.,44.,length(vEyePosition.xyz-vPositionW)));
          float mullion=(1.-smoothstep(.012-edge.x,.012+edge.x,uv.x))*detail;
          vec3 glazing=baseColor.rgb*vec3(.22,.33,.38)+vec3(.035,.059,.072);
          baseColor.rgb=mix(baseColor.rgb,glazing,window*(1.-mullion*.65));
          if(cityNight>=${FIRST_WINDOW_THRESHOLD}){
          vec2 room=floor(cell)+floor(vPositionW.xz/64.);
          float occupied=fract(sin(dot(room,vec2(12.9898,78.233)))*43758.5453);
          float switchedOn=step(${FIRST_WINDOW_THRESHOLD}+.55*fract(occupied*153.7),cityNight);
          vec3 warm=mix(vec3(.58,.54,.46),vec3(.49,.52,.53),step(.985,occupied));
          float interior=(.45+.35*fract(cell.y))*(.85+.15*step(.15,fract(cell.y*8.)));
          float bright=mix(.25,1.5,step(.975,occupied));
          cityWindowGlow=warm*switchedOn*window*(1.-mullion*.9)*smoothstep(.87,.90,occupied)*interior*bright*1.0;
          }
        }
      `,
    }:null;
  }
}
