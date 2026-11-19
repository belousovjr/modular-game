import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { Material } from '@babylonjs/core/Materials/material.js';

export class WindowGlass extends MaterialPluginBase {
  constructor(material: Material) {
    super(material,'WindowGlass',210,{},true,true);
  }

  getClassName() { return 'WindowGlass'; }

  getCustomCode(type:string) {
    return type==='fragment' ? {CUSTOM_FRAGMENT_BEFORE_LIGHTS:`
      float edge=1.-abs(dot(normalW,viewDirectionW));
      alpha+=.11*edge*edge;
    `} : null;
  }
}
