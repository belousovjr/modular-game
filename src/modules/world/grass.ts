import {containsBuildingFootprint} from './footprint.ts';
import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { BoundingInfo } from '@babylonjs/core/Culling/boundingInfo.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Scope } from '../../core/modules.ts';
import type { SectionBounds } from '../world-streaming/index.ts';
import { grassTexel } from './grass-palette.ts';
import type { CitySource } from '../world-generation/index.ts';

const PATCH = 8;
const STEP = .25;
export const GRASS_DISTANCE = 80;
const NEAR_DISTANCE = 24;

export function grassLodDistance(distance: number, indoors: boolean) {
  return indoors ? distance + 1.5 * Math.max(0, distance - 12) : distance;
}

type Triangle = { positions: readonly number[]; a: number; b: number; c: number };

type GrassPatch = { bounds: SectionBounds; triangles: Triangle[]; buildings: CitySource['colliders'][number][] };

export function groupGrass(city: CitySource) {
  const patches = new Map<string, GrassPatch>();
  for (const chunk of city.chunks) for (const {surface, positions, indices} of chunk.meshes) {
    if (surface !== 'terrain') continue;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
      const minX = Math.floor(Math.min(positions[a], positions[b], positions[c]) / PATCH);
      const maxX = Math.ceil(Math.max(positions[a], positions[b], positions[c]) / PATCH);
      const minZ = Math.floor(Math.min(positions[a + 2], positions[b + 2], positions[c + 2]) / PATCH);
      const maxZ = Math.ceil(Math.max(positions[a + 2], positions[b + 2], positions[c + 2]) / PATCH);
      const triangle = { positions, a, b, c };
      for (let x = minX; x < maxX; x++) for (let z = minZ; z < maxZ; z++) {
        const key = `${x}/${z}`;
        let patch = patches.get(key);
        if (!patch) {
          patch = { bounds: { minX: x * PATCH, minZ: z * PATCH, maxX: (x + 1) * PATCH, maxZ: (z + 1) * PATCH }, triangles: [], buildings: [] };
          patches.set(key, patch);
        }
        patch.triangles.push(triangle);
      }
    }
  }
  for (const building of city.colliders) {
    for (let x=Math.floor(building.minX/PATCH);x<=Math.floor(building.maxX/PATCH);x++)
      for (let z=Math.floor(building.minZ/PATCH);z<=Math.floor(building.maxZ/PATCH);z++)
        patches.get(`${x}/${z}`)?.buildings.push(building);
  }
  return patches;
}

export function groupGrassSections(patches: Iterable<GrassPatch>) {
  const span = PATCH * 4;
  const sections = new Map<string, { bounds: SectionBounds; patches: GrassPatch[] }>();
  for (const patch of patches) {
    const x = Math.floor(patch.bounds.minX / span), z = Math.floor(patch.bounds.minZ / span);
    const key = `${x}/${z}`;
    let section = sections.get(key);
    if (!section) {
      section = { bounds: { minX: x * span, minZ: z * span, maxX: (x + 1) * span, maxZ: (z + 1) * span }, patches: [] };
      sections.set(key, section);
    }
    section.patches.push(patch);
  }
  return sections;
}

export function grassPatchDistance(bounds: SectionBounds, point: Vector3) {
  return Math.hypot(
    Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX),
    Math.max(bounds.minZ - point.z, 0, point.z - bounds.maxZ),
  );
}

function hash(x: number, z: number, salt: number) {
  const n = Math.imul(x, 1597334677) ^ Math.imul(z, 3812015801) ^ Math.imul(salt, 2246822519);
  return ((Math.imul(n ^ (n >>> 16), 668265263) ^ (n >>> 13)) >>> 0) / 4294967296;
}

export function sampleGrass({bounds, triangles, buildings}: GrassPatch) {
  const roots: { x: number; y: number; z: number; order: number }[] = [];
  for (let row = bounds.minZ / STEP; row < bounds.maxZ / STEP; row++) {
    for (let col = bounds.minX / STEP; col < bounds.maxX / STEP; col++) {
      const x = (col + hash(col, row, 1)) * STEP;
      const z = (row + hash(col, row, 2)) * STEP;
      if (buildings.some(building=>containsBuildingFootprint(building,x,z))) continue;
      for (const {positions: p, a, b, c} of triangles) {
        const bx = p[b] - p[a], bz = p[b + 2] - p[a + 2];
        const cx = p[c] - p[a], cz = p[c + 2] - p[a + 2];
        const det = bx * cz - bz * cx;
        if (Math.abs(det) < 1e-8) continue;
        const dx = x - p[a], dz = z - p[a + 2];
        const u = (dx * cz - dz * cx) / det, v = (bx * dz - bz * dx) / det;
        if (u < 0 || v < 0 || u + v > 1) continue;
        const y = p[a + 1] + u * (p[b + 1] - p[a + 1]) + v * (p[c + 1] - p[a + 1]);
        roots.push({ x, y, z, order: hash(col, row, 3) });
        break;
      }
    }
  }
  return roots.sort((a, b) => a.order - b.order);
}

class GrassWind extends MaterialPluginBase {
  time = 0;
  constructor(material: StandardMaterial) { super(material, 'GrassWind', 210, {}, true, true); }
  getClassName() { return 'GrassWind'; }
  getUniforms() {
    return { ubo: [{ name: 'grassTime', size: 1, type: 'float' }], vertex: '#ifndef UNIFORMBUFFERS\nuniform float grassTime;\n#endif' };
  }
  bindForSubMesh(buffer: UniformBuffer) { buffer.updateFloat('grassTime', this.time); }
  getCustomCode(type: string) {
    if (type !== 'vertex') return null;
    return { CUSTOM_VERTEX_UPDATE_POSITION: `
      #ifdef THIN_INSTANCES
        float wave = sin(dot(world3.xz, vec2(0.44, 0.31)) - grassTime * 1.9);
        float flutter = sin(dot(world3.xz, vec2(-1.7, 2.1)) + grassTime * 3.7);
        vec2 wind = vec2(0.8, 0.35) * (0.08 + 0.09 * wave + 0.026 * flutter);
        vec2 localX = normalize(world0.xz);
        vec2 localZ = normalize(world2.xz);
        float bend = position.y * position.y;
        positionUpdated.x += bend * dot(wind, localX);
        positionUpdated.z += bend * dot(wind, localZ);
      #endif
    ` };
  }
}

export function createGrass(scene: Scene, scope: Scope) {
  const material = new StandardMaterial('world/grass', scene);
  scope.onDispose(() => material.dispose());
  const normal = new Texture(`${import.meta.env?.BASE_URL ?? '/'}textures/city/grass-normal.webp`, scene);
  scope.onDispose(() => normal.dispose());
  normal.gammaSpace = false;
  normal.level = .25;
  material.bumpTexture = normal;
  material.specularColor = Color3.Black();
  material.backFaceCulling = false;
  const wind = new GrassWind(material);
  const observer = scene.onBeforeRenderObservable.add(() => {
    wind.time += scene.getEngine().getDeltaTime() / 1000;
  });
  scope.onDispose(() => scene.onBeforeRenderObservable.remove(observer));

  const blades = [false, true].map(far => {
    const data = new VertexData();
    data.positions = far
      ? [-.045, 0, 0, .045, 0, 0, .018, 1, .12]
      : [-.028, 0, 0, .028, 0, 0, -.012, .53, .035, .021, .53, .035, .018, 1, .12];
    data.indices = far ? [0, 1, 2] : [0, 1, 2, 1, 3, 2, 2, 3, 4];
    data.uvs = far ? [0, 0, 1, 0, .5, 1] : [0, 0, 1, 0, 0, .53, 1, .53, .5, 1];
    data.normals = [];
    VertexData.ComputeNormals(data.positions, data.indices, data.normals);
    // Light both sides like foliage rooted in an upward-facing surface.
    for (let i = 1; i < data.normals.length; i += 3) {
      data.normals[i] = .65 + Math.abs(data.normals[i]);
    }
    data.colors = data.positions.flatMap((value, index) => index % 3 === 1
      ? [.9 + .24 * value, .9 + .24 * value, .9 + .24 * value, 1] : []);
    return data;
  });

  return (id: string, patch: GrassPatch, owner: Scope, register: (meshes: readonly Mesh[], owner: Scope) => void) => {
    const roots = sampleGrass(patch);
    if (!roots.length) return () => {};
    const buffer = new Float32Array(roots.length * 16);
    const colors = new Float32Array(roots.length * 4);
    const matrix = Matrix.Identity();
    const angle = Matrix.Identity();
    const farCount = Math.ceil(roots.length * .3);
    let minY = Infinity, maxY = -Infinity;
    for (const [index, {x, y, z}] of roots.entries()) {
      const col = Math.floor(x / STEP), row = Math.floor(z / STEP);
      const rgb = grassTexel(x, z);
      const red = rgb >>> 16, green = (rgb >>> 8) & 255, blue = rgb & 255;
      const size = hash(col, row, 4);
      const growth = .024 * (green - 73);
      const height = .19 + .18 * size + .22 * growth;
      const width = .82 + .36 * size + growth;
      const shade = (1.06 + (hash(col, row, 6) - .5) * (.14 - .10 * size)) / 255;
      const colorOffset = index * 4;
      colors[colorOffset] = red * shade;
      colors[colorOffset + 1] = green * shade;
      colors[colorOffset + 2] = blue * shade;
      colors[colorOffset + 3] = 1;
      Matrix.RotationYToRef(hash(col, row, 5) * Math.PI * 2, angle);
      Matrix.ScalingToRef(width, height, 1, matrix);
      matrix.multiplyToRef(angle, matrix);
      matrix.setTranslationFromFloats(x, y, z);
      matrix.copyToArray(buffer, index * 16);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const { minX, maxX, minZ, maxZ } = patch.bounds;
    const levels: (Mesh | undefined)[] = [];
    return (camera?: Vector3, indoors = false) => {
      const distance = camera ? grassLodDistance(Math.hypot(
        grassPatchDistance(patch.bounds, camera), Math.max(minY - camera.y, 0, camera.y - maxY),
      ), indoors) : Infinity;
      // shortcut: abruptly switches blade geometry at 24 m, revisit if the switch is visible in motion.
      const level = distance < NEAR_DISTANCE ? 0 : 1;
      const count = level === 0
        ? Math.round(farCount + (roots.length - farCount) * Math.min(1, (NEAR_DISTANCE - distance) / 12))
        : Math.round(farCount * Math.max(0, (GRASS_DISTANCE - distance) / (GRASS_DISTANCE - NEAR_DISTANCE)));
      const other = levels[1 - level];
      if (other?.isEnabled()) other.setEnabled(false);
      let mesh = levels[level];
      if (!count) {
        if (mesh?.isEnabled()) mesh.setEnabled(false);
        return;
      }
      if (!mesh) {
        const created = new Mesh(`${id}/${level}`, scene);
        owner.onDispose(() => created.dispose());
        mesh = created;
        mesh.metadata = { shadowCaster: false, grassLod: level };
        mesh.isPickable = false;
        mesh.material = material;
        // Babylon stores thin-instance matrix attributes on Geometry, so each patch needs its own.
        blades[level].applyToMesh(mesh);
        mesh.doNotSyncBoundingInfo = true;
        mesh.thinInstanceSetBuffer('matrix', level === 0 ? buffer : buffer.subarray(0, farCount * 16), 16, true);
        mesh.thinInstanceSetBuffer('color', level === 0 ? colors : colors.subarray(0, farCount * 4), 4, true);
        // Include the vertex shader's maximum displacement in patch culling.
        mesh.setBoundingInfo(new BoundingInfo(new Vector3(minX - .35, minY, minZ - .35), new Vector3(maxX + .35, maxY + .42, maxZ + .35)));
        mesh.freezeWorldMatrix();
        register([mesh], owner);
        levels[level] = mesh;
      }
      mesh.thinInstanceCount = count;
      if (!mesh.isEnabled()) mesh.setEnabled(true);
    };
  };
}
