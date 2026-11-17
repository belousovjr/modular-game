import {MaterialPluginBase} from '@babylonjs/core/Materials/materialPluginBase.js';
import type {Material} from '@babylonjs/core/Materials/material.js';
import type {MaterialDefines} from '@babylonjs/core/Materials/materialDefines.js';
import type {BaseTexture} from '@babylonjs/core/Materials/Textures/baseTexture.js';
import type {UniformBuffer} from '@babylonjs/core/Materials/uniformBuffer.js';

export class NightField extends MaterialPluginBase{
  private texture:BaseTexture|null=null;
  private bounds:readonly number[]=[0,0,1,1];
  private night=0;
  constructor(material:Material){super(material,'NightField',230,{NIGHT_FIELD:false},true);this.doNotSerialize=true;}
  configure(texture:BaseTexture|null,bounds:readonly number[],night:number){
    const active=!!texture,changed=active!==!!this.texture;this.texture=texture;this.bounds=bounds;this.night=night;
    if(changed){this.markAllDefinesAsDirty();this._enable(active);}
  }
  prepareDefines(defines:MaterialDefines){defines.NIGHT_FIELD=!!this.texture;}
  getSamplers(samplers:string[]){samplers.push('nightFieldSampler');}
  getUniforms(){return {ubo:[{name:'nightFieldBounds',size:4,type:'vec4'},{name:'nightFieldFactor',size:1,type:'float'}]};}
  bindForSubMesh(buffer:UniformBuffer){buffer.updateFloat4('nightFieldBounds',this.bounds[0],this.bounds[1],this.bounds[2],this.bounds[3]);buffer.updateFloat('nightFieldFactor',this.night);if(this.texture)buffer.setTexture('nightFieldSampler',this.texture);}
  getActiveTextures(textures:BaseTexture[]){if(this.texture)textures.push(this.texture);}
  hasTexture(texture:BaseTexture){return texture===this.texture;}
  getCustomCode(type:string):Record<string,string>|null{return type==='fragment'?{
    CUSTOM_FRAGMENT_DEFINITIONS:'#ifdef NIGHT_FIELD\nuniform sampler2D nightFieldSampler;\n#endif',
    CUSTOM_FRAGMENT_BEFORE_FOG:`
      #ifdef NIGHT_FIELD
      if(nightFieldFactor>.001){
        vec2 fieldUV=(vPositionW.xz-nightFieldBounds.xy)/nightFieldBounds.zw;
        vec3 field=texture2D(nightFieldSampler,clamp(fieldUV,0.,1.)).rgb;
        float inside=step(0.,fieldUV.x)*step(0.,fieldUV.y)*step(fieldUV.x,1.)*step(fieldUV.y,1.);
        float distant=smoothstep(24.,60.,length(vEyePosition.xyz-vPositionW));
        float amount=mix(field.r,field.g,distant)+field.b*.22;
        color.rgb+=baseColor.rgb*vec3(1.,.84,.65)*amount*nightFieldFactor*1.6*inside*smoothstep(.3,.8,normalW.y);
      }
      #endif`,
  }:null;}
}
