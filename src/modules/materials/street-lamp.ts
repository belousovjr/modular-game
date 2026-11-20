import {MaterialPluginBase} from '@babylonjs/core/Materials/materialPluginBase.js';
import type {Material} from '@babylonjs/core/Materials/material.js';
import type {UniformBuffer} from '@babylonjs/core/Materials/uniformBuffer.js';

const thresholds = [.35, .5, .65] as const;
export function streetLampPhase(x: number, z: number) {
  const cell = Math.floor(x + .375) * 37 + Math.floor(z + .375) * 157;
  const key = ((cell % 251) + 251) % 251;
  return ((key * key * 17 + key * 13) % 257) % 3;
}
export function activeStreetLampPhases(night: number) {
  return Number(night >= thresholds[0]) + Number(night >= thresholds[1]) + Number(night >= thresholds[2]);
}

export class StreetLamp extends MaterialPluginBase {
  activePhases = 3;
  constructor(material: Material) { super(material, 'StreetLamp', 220, {}, true, true); }
  getClassName() { return 'StreetLamp'; }
  getUniforms() { return {ubo:[{name:'streetLampPhases',size:1,type:'float'}]}; }
  bindForSubMesh(buffer: UniformBuffer) { buffer.updateFloat('streetLampPhases', this.activePhases); }
  getCustomCode(type: string): Record<string,string> | null {
    if (type === 'vertex') return {
      CUSTOM_VERTEX_DEFINITIONS: 'varying float vStreetLampPhase;',
      CUSTOM_VERTEX_MAIN_END: `
        // Same integer hash as streetLampPhase, based on the transformed centre of the lamp head.
        vec2 anchor = floor(finalWorld[3].xz + .375);
        float key = mod(dot(anchor, vec2(37., 157.)), 251.);
        vStreetLampPhase = mod(mod(key * key * 17. + key * 13., 257.), 3.);
      `,
    };
    return type === 'fragment' ? {
      CUSTOM_FRAGMENT_DEFINITIONS: 'varying float vStreetLampPhase;',
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
        float streetLampOn = step(vStreetLampPhase + .5, streetLampPhases);
        diffuseColor *= mix(.18, 1., streetLampOn);
      `,
      '!vec3 emissiveColor=vEmissiveColor;': 'vec3 emissiveColor=vEmissiveColor*streetLampOn;',
    } : null;
  }
}
