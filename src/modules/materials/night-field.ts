import { FIRST_WINDOW_THRESHOLD } from './city-surface.ts';
import { activeStreetLampPhases } from './street-lamp.ts';
import {MaterialPluginBase} from '@babylonjs/core/Materials/materialPluginBase.js';
import type {Material} from '@babylonjs/core/Materials/material.js';
import type {MaterialDefines} from '@babylonjs/core/Materials/materialDefines.js';
import type {BaseTexture} from '@babylonjs/core/Materials/Textures/baseTexture.js';
import type {UniformBuffer} from '@babylonjs/core/Materials/uniformBuffer.js';

export class NightField extends MaterialPluginBase{
  private texture:BaseTexture|null=null;
  private bounds:readonly number[]=[0,0,1,1];
  private phases=0;
  private windows=0;
  constructor(material:Material){super(material,'NightField',230,{NIGHT_FIELD:false},true);this.doNotSerialize=true;}
  configure(texture:BaseTexture|null,bounds:readonly number[],night:number){
    const active=!!texture,changed=active!==!!this.texture;this.texture=texture;this.bounds=bounds;this.phases=activeStreetLampPhases(night);this.windows=Number(night>=FIRST_WINDOW_THRESHOLD);
    if(changed){this.markAllDefinesAsDirty();this._enable(active);}
  }
  prepareDefines(defines:MaterialDefines){defines.NIGHT_FIELD=!!this.texture;}
  getSamplers(samplers:string[]){samplers.push('nightFieldSampler');}
  getUniforms(){return {ubo:[{name:'nightFieldBounds',size:4,type:'vec4'},{name:'nightFieldPhases',size:1,type:'float'},{name:'nightFieldWindows',size:1,type:'float'}]};}
  bindForSubMesh(buffer:UniformBuffer){buffer.updateFloat4('nightFieldBounds',this.bounds[0],this.bounds[1],this.bounds[2],this.bounds[3]);buffer.updateFloat('nightFieldPhases',this.phases);buffer.updateFloat('nightFieldWindows',this.windows);if(this.texture)buffer.setTexture('nightFieldSampler',this.texture);}
  getActiveTextures(textures:BaseTexture[]){if(this.texture)textures.push(this.texture);}
  hasTexture(texture:BaseTexture){return texture===this.texture;}
  getCustomCode(type:string):Record<string,string>|null{return type==='fragment'?{
    CUSTOM_FRAGMENT_DEFINITIONS:'#ifdef NIGHT_FIELD\nuniform sampler2D nightFieldSampler;\n#endif',
    CUSTOM_FRAGMENT_BEFORE_FOG:`
      #ifdef NIGHT_FIELD
      if(nightFieldPhases>0. || nightFieldWindows>0.){
        vec2 fieldUV=(vPositionW.xz-nightFieldBounds.xy)/nightFieldBounds.zw;
        float inside=step(0.,min(fieldUV.x,fieldUV.y))*step(max(fieldUV.x,fieldUV.y),1.);
        float distant=smoothstep(24.,60.,length(vEyePosition.xyz-vPositionW));
        vec2 uv=clamp(fieldUV,.002,.998)*vec2(1.,.5);
        vec4 field=vec4(0.);
        if(distant<1.)field=texture2D(nightFieldSampler,uv);
        if(distant>0.)field=mix(field,texture2D(nightFieldSampler,uv+vec2(0.,.5)),distant);
        float amount=min(1.,dot(field.rgb,step(vec3(.5,1.5,2.5),vec3(nightFieldPhases))))+field.a*.22*nightFieldWindows;
        color.rgb+=baseColor.rgb*vec3(1.,.84,.65)*amount*1.6*inside*smoothstep(.3,.8,normalW.y);
      }
      #endif`,
  }:null;}
}
