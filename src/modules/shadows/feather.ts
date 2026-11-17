import {ShaderStore} from '@babylonjs/core/Engines/shaderStore.js';
import {shadowMapVertexShader} from '@babylonjs/core/Shaders/shadowMap.vertex.js';
import {shadowMapPixelShader} from '@babylonjs/core/Shaders/shadowMap.fragment.js';
import type {ShadowGenerator} from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import type {Scope} from '../../core/modules.ts';

const shaderName='modularShadowFeather';

// Preserve Babylon's depth encoding, alpha tests and bias. Only opted-in rounded proxies dither their edge.
export function installShadowFeather(generator:ShadowGenerator,owner:Scope){
  if(generator.getLight().getScene().getEngine().isWebGPU)return;
  ShaderStore.ShadersStore[shaderName+'VertexShader']??=shadowMapVertexShader.shader
    .replace('#define CUSTOM_VERTEX_DEFINITIONS','varying float proxyShadowFacing;')
    .replace('#include<shadowMapVertexNormalBias>',`
      proxyShadowFacing=1.0;
      #ifdef NORMAL
      proxyShadowFacing=dot(vNormalW,normalize(lightDataSM.xyz));
      #endif
      #include<shadowMapVertexNormalBias>`);
  ShaderStore.ShadersStore[shaderName+'PixelShader']??=shadowMapPixelShader.shader
    .replace('#define CUSTOM_FRAGMENT_DEFINITIONS',`
      #if SM_SOFTTRANSPARENTSHADOW!=1
      #include<bayerDitherFunctions>
      #endif
      varying float proxyShadowFacing; uniform float proxyShadowFeather;`)
    .replace('#include<shadowMapFragment>',`
      if(proxyShadowFeather>0.0){
        float coverage=smoothstep(0.04,proxyShadowFeather,abs(proxyShadowFacing));
        if(bayerDither8(floor(mod(gl_FragCoord.xy,8.0)))/64.0>=coverage)discard;
      }
      #include<shadowMapFragment>`);
  generator.customShaderOptions={shaderName,uniforms:['proxyShadowFeather']};
  let feather=0;
  const meshObserver=generator.onBeforeShadowMapRenderMeshObservable.add(mesh=>{
    const requested=mesh.metadata?.shadowFeather;
    feather=typeof requested==='number'&&Number.isFinite(requested)?Math.max(0,Math.min(1,requested)):0;
  });
  owner.onDispose(()=>generator.onBeforeShadowMapRenderMeshObservable.remove(meshObserver));
  const effectObserver=generator.onBeforeShadowMapRenderObservable.add(effect=>effect.setFloat('proxyShadowFeather',feather));
  owner.onDispose(()=>generator.onBeforeShadowMapRenderObservable.remove(effectObserver));
}
