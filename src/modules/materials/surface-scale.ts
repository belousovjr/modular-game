import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture.js';
import type { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer.js';

export const FACADE_PATCH = Object.freeze({ width: 0.75, height: 0.18, center: 0.55 });

// Shared by ordinary boxes and thin instances: finalWorld includes each instance's dimensions.
export class SurfaceScale extends MaterialPluginBase {
  private readonly atlas: boolean;
  private readonly material: StandardMaterial;
  private readonly readTexture: (family: string) => Texture | undefined;
  constructor(material: StandardMaterial, atlas: boolean, readTexture: (family: string) => Texture | undefined, city=false) {
    super(material, 'SurfaceScale', 190, { SURFACE_ATLAS: atlas||city,SURFACE_CITY:city }, true, true);
    this.atlas = atlas||city;
    this.material = material;
    this.readTexture = readTexture;
    this.doNotSerialize = true;
  }
  getClassName() { return 'SurfaceScale'; }
  getAttributes(attributes: string[]) { if (!attributes.includes('normal')) attributes.push('normal'); }
  getSamplers(samplers: string[]) { samplers.push('surfaceRoofSampler', 'surfaceBaseSampler', 'surfaceMetalSampler', 'surfaceRoofNormalSampler', 'surfaceBaseNormalSampler', 'surfaceMetalNormalSampler'); }
  getUniforms() {
    return { ubo: [{ name: 'surfaceSourcesReady', size: 3, type: 'vec3' }, { name: 'surfaceNormalsReady', size: 3, type: 'vec3' }], fragment: '#ifndef UNIFORMBUFFERS\nuniform vec3 surfaceSourcesReady;\nuniform vec3 surfaceNormalsReady;\n#endif' };
  }
  bindForSubMesh(buffer: UniformBuffer) {
    if (!this.atlas) return;
    for (const normal of [false, true]) {
      const sources = ['roof', 'concrete', 'metal'].map(family => this.readTexture(`${family}${normal ? '-normal' : ''}`));
      const ready = sources.map(texture => texture?.isReady() ?? false);
      buffer.updateFloat3(normal ? 'surfaceNormalsReady' : 'surfaceSourcesReady', ready[0] ? 1 : 0, ready[1] ? 1 : 0, ready[2] ? 1 : 0);
      for (const [index, name] of ['Roof', 'Base', 'Metal'].entries()) {
        buffer.setTexture(`surface${name}${normal ? 'Normal' : ''}Sampler`, ready[index] ? sources[index] ?? null : (normal ? this.material.bumpTexture : this.material.diffuseTexture));
      }
    }
  }
  getActiveTextures(active: BaseTexture[]) {
    if (this.atlas) for (const family of ['roof', 'concrete', 'metal', 'roof-normal', 'concrete-normal', 'metal-normal']) {
      const texture = this.readTexture(family);
      if (texture) active.push(texture);
    }
  }
  hasTexture(texture: BaseTexture) {
    return this.atlas && ['roof', 'concrete', 'metal', 'roof-normal', 'concrete-normal', 'metal-normal'].some(family => this.readTexture(family) === texture);
  }
  getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') return {
      CUSTOM_VERTEX_DEFINITIONS: `
        #if !defined(NORMAL) && !defined(CITY_NORMAL_DECLARED)
        #define CITY_NORMAL_DECLARED
        attribute vec3 normal;
        #endif
        varying vec2 vSurfaceMeters;
        varying vec2 vSurfaceAtlasUV;`,
      CUSTOM_VERTEX_MAIN_END: `
        #if defined(DIFFUSE) || defined(BUMP)
        vec3 surfaceX = finalWorld[0].xyz / max(length(finalWorld[0].xyz), 0.000001);
        vec3 surfaceY = finalWorld[1].xyz / max(length(finalWorld[1].xyz), 0.000001);
        vec3 surfaceZ = finalWorld[2].xyz / max(length(finalWorld[2].xyz), 0.000001);
        vec3 surfacePosition = vec3(dot(worldPos.xyz, surfaceX), dot(worldPos.xyz, surfaceY), dot(worldPos.xyz, surfaceZ));
        vec3 surfaceNormal = abs(normal);
        vSurfaceMeters = (surfaceNormal.y > 0.5 ? surfacePosition.xz : (surfaceNormal.x > 0.5 ? surfacePosition.zy : surfacePosition.xy)) / 2.0;
        vSurfaceAtlasUV = uv;
        #if defined(SURFACE_CITY) && !defined(FITTED_SURFACE_UV)
        vSurfaceAtlasUV=vec2(normal.y>.5?-2.:(normal.y<-.5?-1.:0.));
        #endif
        #endif`,
    };
    if (shaderType !== 'fragment') return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
        varying vec2 vSurfaceMeters;
        varying vec2 vSurfaceAtlasUV;
        #ifdef SURFACE_ATLAS
        uniform sampler2D surfaceRoofSampler;
        uniform sampler2D surfaceBaseSampler;
        uniform sampler2D surfaceMetalSampler;
        uniform sampler2D surfaceRoofNormalSampler;
        uniform sampler2D surfaceBaseNormalSampler;
        uniform sampler2D surfaceMetalNormalSampler;
        #endif
        float surfaceMipBias() { return 3.0*smoothstep(12.,80.,length(vEyePosition.xyz-vPositionW)); }
        vec4 surfaceSample(sampler2D image, vec2 coords, vec2 dx, vec2 dy) {
          #if __VERSION__ >= 300
          float scale=exp2(surfaceMipBias());
          return textureGrad(image, coords, dx*scale, dy*scale);
          #else
          return texture2D(image, coords, surfaceMipBias());
          #endif
        }
        vec4 surfacePlainSample(sampler2D image, vec2 coords) {
          #if __VERSION__ >= 300
          return surfaceSample(image,coords,dFdx(coords),dFdy(coords));
          #else
          return texture2D(image,coords,surfaceMipBias());
          #endif
        }
        vec4 surfaceTile(sampler2D wall, sampler2D roof, sampler2D base, sampler2D metal, vec3 ready, bool normalMap) {
        #ifdef SURFACE_ATLAS
        #ifdef SURFACE_CITY
        bool marker=vSurfaceAtlasUV.x<-2.5;
        bool roofRole=vSurfaceAtlasUV.x<-1.5 && vSurfaceAtlasUV.x>-2.5;
        bool baseRole=vSurfaceAtlasUV.x<-.5 && vSurfaceAtlasUV.x>-1.5;
        #else
        vec2 cell = floor(vSurfaceAtlasUV * 2.0);
        vec2 face = (vSurfaceAtlasUV - cell * 0.5 - vec2(1.0 / 64.0)) / (30.0 / 64.0);
        bool markedWall = cell.x < 0.5 && cell.y < 0.5;
        bool marker = markedWall && face.x >= ${((1 - FACADE_PATCH.width) / 2).toFixed(6)} && face.x <= ${((1 + FACADE_PATCH.width) / 2).toFixed(6)} && face.y >= ${(1 - FACADE_PATCH.center - FACADE_PATCH.height / 2).toFixed(6)} && face.y <= ${(1 - FACADE_PATCH.center + FACADE_PATCH.height / 2).toFixed(6)};
        bool roofRole=cell.x<.5 && cell.y>.5;
        bool baseRole=cell.x>.5 && cell.y<.5;
        #endif
        vec2 dx = vec2(0.0);
        vec2 dy = vec2(0.0);
        #if __VERSION__ >= 300
        dx = dFdx(vSurfaceMeters);
        dy = dFdy(vSurfaceMeters);
        #endif
        if (marker && ready.z > 0.5) {
          if (normalMap && surfaceNormalsReady.z < 0.5) return vec4(0.5, 0.5, 1.0, 1.0);
          return surfaceSample(metal, vSurfaceMeters, dx, dy);
        } else if (roofRole && ready.x > 0.5) {
          if (normalMap && surfaceNormalsReady.x < 0.5) return vec4(0.5, 0.5, 1.0, 1.0);
          return surfaceSample(roof, vSurfaceMeters, dx, dy);
        } else if (baseRole && ready.y > 0.5) {
          if (normalMap && surfaceNormalsReady.y < 0.5) return vec4(0.5, 0.5, 1.0, 1.0);
          return surfaceSample(base, vSurfaceMeters, dx, dy);
        } else {
          return surfaceSample(wall, vSurfaceMeters, dx, dy);
        }
        #else
        return surfacePlainSample(wall, vSurfaceMeters);
        #endif
        }`,
      '!baseColor=TEXRD\\(diffuseSampler,vDiffuseUV\\+uvOffset\\);': `
        #ifdef SURFACE_ATLAS
        baseColor = surfaceTile(diffuseSampler, surfaceRoofSampler, surfaceBaseSampler, surfaceMetalSampler, surfaceSourcesReady, false);
        #else
        baseColor = surfacePlainSample(diffuseSampler, vSurfaceMeters);
        #endif`,
      '!vec2 TBNUV=gl_FrontFacing \\? vBumpUV : -vBumpUV;': 'vec2 TBNUV=gl_FrontFacing ? vSurfaceMeters : -vSurfaceMeters;',
      '!TEXRD\\(bumpSampler,vBumpUV\\+uvOffset\\)': `
        #ifdef SURFACE_ATLAS
        surfaceTile(bumpSampler, surfaceRoofNormalSampler, surfaceBaseNormalSampler, surfaceMetalNormalSampler, surfaceSourcesReady, true)
        #else
        surfacePlainSample(bumpSampler, vSurfaceMeters)
        #endif
      `,
    };
  }
}
