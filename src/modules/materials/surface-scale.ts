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
  constructor(material: StandardMaterial, atlas: boolean, readTexture: (family: string) => Texture | undefined) {
    super(material, 'SurfaceScale', 190, { SURFACE_ATLAS: atlas }, true, true);
    this.atlas = atlas;
    this.material = material;
    this.readTexture = readTexture;
    this.doNotSerialize = true;
  }
  getClassName() { return 'SurfaceScale'; }
  getAttributes(attributes: string[]) { if (!attributes.includes('normal')) attributes.push('normal'); }
  getSamplers(samplers: string[]) { samplers.push('surfaceRoofSampler', 'surfaceBaseSampler', 'surfaceMetalSampler'); }
  getUniforms() {
    return { ubo: [{ name: 'surfaceSourcesReady', size: 3, type: 'vec3' }], fragment: '#ifndef UNIFORMBUFFERS\nuniform vec3 surfaceSourcesReady;\n#endif' };
  }
  bindForSubMesh(buffer: UniformBuffer) {
    if (!this.atlas) return;
    const sources = ['roof', 'concrete', 'metal'].map(family => this.readTexture(family));
    const ready = sources.map(texture => texture?.isReady() ?? false);
    buffer.updateFloat3('surfaceSourcesReady', ready[0] ? 1 : 0, ready[1] ? 1 : 0, ready[2] ? 1 : 0);
    for (const [index, sampler] of ['surfaceRoofSampler', 'surfaceBaseSampler', 'surfaceMetalSampler'].entries()) {
      buffer.setTexture(sampler, ready[index] ? sources[index] ?? null : this.material.diffuseTexture);
    }
  }
  getActiveTextures(active: BaseTexture[]) {
    if (this.atlas) for (const family of ['roof', 'concrete', 'metal']) {
      const texture = this.readTexture(family);
      if (texture) active.push(texture);
    }
  }
  hasTexture(texture: BaseTexture) {
    return this.atlas && ['roof', 'concrete', 'metal'].some(family => this.readTexture(family) === texture);
  }
  getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType === 'vertex') return {
      CUSTOM_VERTEX_DEFINITIONS: `
        #ifndef NORMAL
        attribute vec3 normal;
        #endif
        varying vec2 vSurfaceMeters;
        varying vec2 vSurfaceAtlasUV;`,
      CUSTOM_VERTEX_MAIN_END: `
        #ifdef DIFFUSE
        vec3 surfaceX = finalWorld[0].xyz / max(length(finalWorld[0].xyz), 0.000001);
        vec3 surfaceY = finalWorld[1].xyz / max(length(finalWorld[1].xyz), 0.000001);
        vec3 surfaceZ = finalWorld[2].xyz / max(length(finalWorld[2].xyz), 0.000001);
        vec3 surfacePosition = vec3(dot(worldPos.xyz, surfaceX), dot(worldPos.xyz, surfaceY), dot(worldPos.xyz, surfaceZ));
        vec3 surfaceNormal = abs(normal);
        vSurfaceMeters = (surfaceNormal.y > 0.5 ? surfacePosition.xz : (surfaceNormal.x > 0.5 ? surfacePosition.zy : surfacePosition.xy)) / 2.0;
        vSurfaceAtlasUV = uv;
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
        vec4 surfaceSample(sampler2D image, vec2 coords, vec2 dx, vec2 dy) {
          #if __VERSION__ >= 300
          return textureGrad(image, coords, dx, dy);
          #else
          return texture2D(image, coords);
          #endif
        }
        #endif`,
      '!baseColor=TEXRD\\(diffuseSampler,vDiffuseUV\\+uvOffset\\);': `
        #ifdef SURFACE_ATLAS
        vec2 cell = floor(vSurfaceAtlasUV * 2.0);
        vec2 face = (vSurfaceAtlasUV - cell * 0.5 - vec2(1.0 / 64.0)) / (30.0 / 64.0);
        bool markedWall = cell.x < 0.5 && cell.y < 0.5;
        bool marker = markedWall && face.x >= ${((1 - FACADE_PATCH.width) / 2).toFixed(6)} && face.x <= ${((1 + FACADE_PATCH.width) / 2).toFixed(6)} && face.y >= ${(1 - FACADE_PATCH.center - FACADE_PATCH.height / 2).toFixed(6)} && face.y <= ${(1 - FACADE_PATCH.center + FACADE_PATCH.height / 2).toFixed(6)};
        vec2 dx = vec2(0.0);
        vec2 dy = vec2(0.0);
        #if __VERSION__ >= 300
        dx = dFdx(vSurfaceMeters);
        dy = dFdy(vSurfaceMeters);
        #endif
        if (marker && surfaceSourcesReady.z > 0.5) {
          baseColor = surfaceSample(surfaceMetalSampler, vSurfaceMeters, dx, dy);
        } else if (cell.x < 0.5 && cell.y > 0.5 && surfaceSourcesReady.x > 0.5) {
          baseColor = surfaceSample(surfaceRoofSampler, vSurfaceMeters, dx, dy);
        } else if (cell.x > 0.5 && cell.y < 0.5 && surfaceSourcesReady.y > 0.5) {
          baseColor = surfaceSample(surfaceBaseSampler, vSurfaceMeters, dx, dy);
        } else {
          baseColor = surfaceSample(diffuseSampler, vSurfaceMeters, dx, dy);
        }
        #else
        baseColor = TEXRD(diffuseSampler, vSurfaceMeters);
        #endif`,
    };
  }
}
