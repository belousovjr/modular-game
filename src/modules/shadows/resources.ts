import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js';
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js';
import { Frustum } from '@babylonjs/core/Maths/math.frustum.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from '../../core/modules.ts';
import type { DistancePoint } from '../object-rendering/index.ts';

const MAP_SIZE = 1024;
const CASCADE_MAP_SIZE = 1024;
// WebGL1/NullEngine fallback keeps a single bounded map.
const HALF_SIZE = 80;
const CASTER_RADIUS = 128;
const SHADOW_DISTANCE = 96;
const SHADOW_MIN_Z = 0.1;
const SHADOW_MAX_Z = 400;

export function createShadows(scene: Scene, sun: DirectionalLight, getMeshes: () => Iterable<Mesh>, readOrigin: () => DistancePoint | null, scope: Scope) {
  if (sun.getShadowGenerator()) throw new Error('У солнца уже есть генератор теней');
  const originalPosition = sun.position.clone();
  const original = { autoUpdateExtends: sun.autoUpdateExtends, autoCalcShadowZBounds: sun.autoCalcShadowZBounds,
    orthoLeft: sun.orthoLeft, orthoRight: sun.orthoRight, orthoTop: sun.orthoTop, orthoBottom: sun.orthoBottom,
    shadowOrthoScale: sun.shadowOrthoScale, shadowMinZ: sun.shadowMinZ, shadowMaxZ: sun.shadowMaxZ, shadowEnabled: sun.shadowEnabled };
  scope.onDispose(() => { Object.assign(sun, original); sun.position.copyFrom(originalPosition); });
  const generator = CascadedShadowGenerator.IsSupported
    ? new CascadedShadowGenerator(CASCADE_MAP_SIZE, sun)
    : new ShadowGenerator(MAP_SIZE, sun);
  scope.onDispose(() => generator.dispose());
  const cascaded = generator instanceof CascadedShadowGenerator ? generator : undefined;
  let cascadePlanesReady = false;
  if (cascaded) {
    cascaded.numCascades = 2;
    cascaded.shadowMaxZ = SHADOW_DISTANCE;
    cascaded.lambda = 0.8;
    cascaded.stabilizeCascades = true;
    cascaded.depthClamp = true;
    cascaded.autoCalcDepthBounds = false;
    cascaded.cascadeBlendPercentage = 0.2;
    cascaded.freezeShadowCastersBoundingInfo = true;
  }
  const planes = Frustum.GetPlanes(Matrix.Identity());
  generator.customAllowRendering = subMesh => !cascadePlanesReady || subMesh.getMesh().isInFrustum(planes);
  const shadowTarget = generator.getShadowMap();
  const mapObserver = shadowTarget?.onBeforeRenderObservable.add(layer => {
    const transform = cascaded ? cascaded.getCascadeTransformMatrix(layer) : generator.getTransformMatrix();
    if (!transform) return;
    Frustum.GetPlanesToRef(transform, planes);
    planes[0].normal.setAll(0); planes[0].d = 1;
    planes[1].normal.setAll(0); planes[1].d = 1;
    for (let side = 2; side < 6; side++) planes[side].d += generator.normalBias;
    cascadePlanesReady = true;
  });
  if (mapObserver) scope.onDispose(() => shadowTarget?.onBeforeRenderObservable.remove(mapObserver));
  generator.usePercentageCloserFiltering = true;
  generator.filteringQuality = cascaded ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
  generator.bias = 0.0005;
  generator.normalBias = 0.12;
  // The legacy map keeps its back-face bias; CSM uses the chicago-test settings.
  generator.forceBackFacesOnly = false;
  generator.frustumEdgeFalloff = 0.1;
  sun.autoUpdateExtends = false;
  sun.autoCalcShadowZBounds = false;
  sun.shadowOrthoScale = 0;
  sun.orthoLeft = sun.orthoBottom = -HALF_SIZE;
  sun.orthoRight = sun.orthoTop = HALF_SIZE;
  sun.shadowMinZ = SHADOW_MIN_Z;
  sun.shadowMaxZ = SHADOW_MAX_Z;
  function depthBias(texel: number, range: number) {
    const vertical = Math.min(1, Math.max(0.2, -sun.direction.y));
    const slope = Math.sqrt(1 - vertical * vertical) / vertical;
    return Math.max(0.0005, 3 * texel * slope / Math.max(1, range));
  }
  const receivers = new Map<Mesh, boolean>();
  scope.onDispose(() => { for (const [mesh, previous] of receivers) if (!mesh.isDisposed()) mesh.receiveShadows = previous; receivers.clear(); });
  const view = Matrix.Identity();
  const inverse = Matrix.Identity();
  const center = Vector3.Zero();
  const up = Vector3.Up();
  const zero = Vector3.Zero();
  function casterRevision(mesh: Mesh) {
    const material = mesh.material;
    return [mesh.visibility, ...mesh.getWorldMatrix().m, material, material?.backFaceCulling, material?.cullBackFaces, material?.fillMode];
  }
  let previousCasters: Mesh[] = [];
  let previousRevisions: ReturnType<typeof casterRevision>[] = [];
  const previousView = Matrix.Zero();
  const previousDirection = Vector3.Zero();
  const previousPosition = Vector3.Zero();
  let previousCamera = scene.activeCamera;
  let previousEnabled = false;
  let revision = 0;
  const shadowMap = generator.getShadowMap();
  if (shadowMap) shadowMap.refreshRate = 0;
  let enabled = false;
  let count = 0;
  let stopped = false;
  scope.onDispose(() => { stopped = true; previousCasters = []; previousRevisions = []; previousCamera = null; });
  const observer = scene.onBeforeRenderObservable.add(() => {
    cascadePlanesReady = false;
    const origin = readOrigin();
    enabled = origin !== null && sun.intensity > 0.05 && sun.direction.y < -0.2;
    sun.shadowEnabled = enabled;
    generator.setDarkness(1 - Math.max(0, Math.min(1, (-sun.direction.y - 0.2) / 0.15)));
    const map = generator.getShadowMap();
    if (!map) return;
    const casters: Mesh[] = [];
    count = 0;
    for (const [mesh] of receivers) if (mesh.isDisposed()) receivers.delete(mesh);
    if (enabled && origin) {
      if (!cascaded) generator.bias = depthBias(HALF_SIZE * 2 / MAP_SIZE, SHADOW_MAX_Z - SHADOW_MIN_Z);
      Matrix.LookAtLHToRef(zero, sun.direction, up, view);
      view.invertToRef(inverse);
      Vector3.TransformCoordinatesToRef(new Vector3(origin.x, origin.y, origin.z), view, center);
      const texel = HALF_SIZE * 2 / MAP_SIZE;
      center.x = Math.round(center.x / texel) * texel;
      center.y = Math.round(center.y / texel) * texel;
      Vector3.TransformCoordinatesToRef(center, inverse, center);
      sun.position.copyFrom(center).addInPlace(sun.direction.scale(-180));
      for (const mesh of getMeshes()) {
        if (mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible) continue;
        if (!receivers.has(mesh)) { receivers.set(mesh, mesh.receiveShadows); mesh.receiveShadows = true; }
        if (mesh.hasThinInstances || mesh.metadata?.shadowCaster === false) continue;
        const world = mesh.computeWorldMatrix(!!mesh.parent || !mesh.isSynchronized());
        const box = mesh.getBoundingInfo().boundingBox;
        const width = box.extendSize.x * 2 * Math.hypot(world.m[0], world.m[1], world.m[2]);
        const height = box.extendSize.y * 2 * Math.hypot(world.m[4], world.m[5], world.m[6]);
        const depth = box.extendSize.z * 2 * Math.hypot(world.m[8], world.m[9], world.m[10]);
        // Broad ground plates receive shadows; casting them causes stripes on overlapping surfaces.
        if (width >= 160 && depth >= 160 && height < 2) continue;
        const min = box.minimumWorld;
        const max = box.maximumWorld;
        const distance = Math.hypot(Math.max(min.x - origin.x, 0, origin.x - max.x), Math.max(min.y - origin.y, 0, origin.y - max.y), Math.max(min.z - origin.z, 0, origin.z - max.z));
        if (distance <= CASTER_RADIUS) casters.push(mesh);
      }
    }
    count = casters.length;
    enabled = enabled && count > 0;
    sun.shadowEnabled = enabled;
    const camera = scene.activeCamera;
    const viewProjection = camera?.getTransformationMatrix();
    const revisions = casters.map(casterRevision);
    const uncached = casters.some(mesh => !(mesh.material instanceof StandardMaterial) || mesh.material.needAlphaTesting() || mesh.material.needAlphaBlendingForMesh(mesh) || mesh.material.shadowDepthWrapper || mesh.skeleton || mesh.morphTargetManager);
    const dirty = uncached || enabled !== previousEnabled || (cascaded && (camera !== previousCamera || !viewProjection || !viewProjection.equals(previousView))) ||
      !sun.direction.equals(previousDirection) || !sun.position.equals(previousPosition) || casters.length !== previousCasters.length ||
      casters.some((mesh, index) => mesh !== previousCasters[index] || revisions[index].some((value, key) => value !== previousRevisions[index]?.[key]));
    if (dirty) {
      map.renderList = casters;
      map.resetRefreshCounter();
      revision++;
      if (cascaded && enabled) {
        // Refresh bounds after LOD changes, then split for the current camera (including test cameras).
        cascaded.freezeShadowCastersBoundingInfo = true;
        cascaded.splitFrustum();
      }
      previousCasters = casters; previousRevisions = revisions;
      previousCamera = camera; previousEnabled = enabled;
      if (viewProjection) previousView.copyFrom(viewProjection);
      previousDirection.copyFrom(sun.direction); previousPosition.copyFrom(sun.position);
    }
  });
  scope.onDispose(() => scene.onBeforeRenderObservable.remove(observer));
  return { getStats() {
    if (stopped) throw new Error('Тени остановлены');
    return { enabled, casters: count, mapSize: cascaded ? CASCADE_MAP_SIZE : MAP_SIZE, halfSize: cascaded ? null : HALF_SIZE, cascades: cascaded ? 2 : 1, revision, casterRadius: CASTER_RADIUS };
  } };
}
