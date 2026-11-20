import { Vector4 } from '@babylonjs/core/Maths/math.vector.js';
import { Color3 } from '@babylonjs/core/Maths/math.color.js';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import {PBRBaseMaterial} from '@babylonjs/core/Materials/PBR/pbrBaseMaterial.js';
import {DitheredTileFadeMaterialPlugin} from '@babylonjs/core/Materials/ditheredTileFadeMaterialPlugin.js';
import { defineModule } from '../../core/context.ts';
import type { Scope } from '../../core/modules.ts';

type Triple = readonly [number, number, number];
export type FaceUV = readonly [number, number, number, number];
export interface GeometryPart {
  readonly surface: string;
  readonly radialSegments?: number;
  readonly size: Triple;
  readonly position?: Triple;
  readonly rotation?: Triple;
  readonly faceUV?: readonly FaceUV[];
}
export interface GeometryModel {
  readonly root: TransformNode;
  readonly surfaces: ReadonlyMap<string, readonly Mesh[]>;
}

export const geometryModule = defineModule({
  id: 'geometry', category: 'Рендеринг', title: 'Геометрия', requires: {},
  setup({ core, scope }) {
    const fallback = new StandardMaterial('geometry-fallback', core.scene);
    scope.onDispose(() => fallback.dispose());
    fallback.disableLighting = true;
    fallback.emissiveColor = Color3.FromHexString('#8899aa');
    const source = MeshBuilder.CreateBox('geometry-box-source', { size: 1 }, core.scene);
    scope.onDispose(() => source.dispose());
    source.isVisible = false;
    source.material = fallback;
    const sources = new Map<string, Mesh>();
    function getRadialSource(segments:number){
      const key=`radial/${segments}`;let mesh=sources.get(key);
      if(!mesh){mesh=MeshBuilder.CreateCylinder(key,{height:1,diameter:1,tessellation:segments},core.scene);scope.onDispose(()=>mesh?.dispose());mesh.isVisible=false;mesh.material=fallback;sources.set(key,mesh);}
      return mesh;
    }
    function getSource(faceUV: readonly FaceUV[] | undefined): Mesh {
      if (!faceUV) return source;
      const key = JSON.stringify(faceUV);
      let variant = sources.get(key);
      if (!variant) {
        variant = MeshBuilder.CreateBox(`geometry-box-uv-${sources.size}`, { size: 1, faceUV: faceUV.map(uv => new Vector4(...uv)) }, core.scene);
        scope.onDispose(() => variant?.dispose());
        const positions = variant.getVerticesData('position');
        const uv = variant.getVerticesData('uv');
        if (!positions || !uv) throw new Error('У куба отсутствуют координаты вершин или UV');
        // Babylon flips V on opposite faces; atlas height must follow local +Y on all walls.
        for (let vertex = 0; vertex < 16; vertex++) {
          uv[vertex * 2 + 1] = faceUV[Math.floor(vertex / 4)][positions[vertex * 3 + 1] > 0 ? 1 : 3];
        }
        variant.setVerticesData('uv', uv);
        variant.isVisible = false;
        variant.material = fallback;
        sources.set(key, variant);
      }
      return variant;
    }
    const borrowed = new Set<Mesh>();
    scope.onDispose(() => borrowed.clear());
    const models = new Map<TransformNode, { surfaces: ReadonlyMap<string, readonly Mesh[]>; detail: number }>();
    const fades=new WeakMap<Mesh,{lower:number;upper:number;material:StandardMaterial|PBRBaseMaterial}>();
    function setMeshFade(mesh:Mesh,lower:number,upper:number){
      if(stopped||mesh.isDisposed()||mesh.getScene()!==core.scene||![lower,upper].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw new Error('Invalid mesh fade');
      const material=mesh.material;
      if(!(material instanceof StandardMaterial)&&!(material instanceof PBRBaseMaterial))throw new Error('Unsupported fade material');
      const previous=fades.get(mesh);
      if(previous&&(previous.material!==material||(lower===0&&upper===1))){DitheredTileFadeMaterialPlugin.GetOrCreate(previous.material).resetFade(mesh);fades.delete(mesh);}
      if(lower===0&&upper===1)return;
      let bounds=fades.get(mesh);if(!bounds){bounds={lower,upper,material};fades.set(mesh,bounds);}else{bounds.lower=lower;bounds.upper=upper;}
      DitheredTileFadeMaterialPlugin.GetOrCreate(material).setFadeBounds(mesh,lower,upper);
    }
    let surfaceMaterials: ReadonlyMap<string, readonly Material[]> | undefined;
    function getSurfaceMaterial(surface: string, detail = 0): Material {
      if (stopped) throw new Error('Модуль геометрии остановлен');
      if (!Number.isSafeInteger(detail) || detail < 0) throw new Error('Некорректный уровень оформления');
      const levels = surfaceMaterials?.get(surface);
      return levels?.[Math.min(detail, levels.length - 1)] ?? fallback;
    }
    function applyMaterials(previous: ReadonlyMap<string, readonly Material[]> | undefined) {
      for (const { surfaces, detail } of models.values()) for (const [surface, meshes] of surfaces) {
        const levels = previous?.get(surface);
        const expected = levels?.[Math.min(detail, levels.length - 1)] ?? fallback;
        for (const mesh of meshes) if (mesh.material === expected) {mesh.material = getSurfaceMaterial(surface, detail);const fade=fades.get(mesh);if(fade)setMeshFade(mesh,fade.lower,fade.upper);}
      }
    }
    function registerSurfaceMaterials(materials: ReadonlyMap<string, readonly Material[]>, owner: Scope) {
      if (stopped) throw new Error('Модуль геометрии остановлен');
      if (surfaceMaterials) throw new Error('Оформление поверхностей уже подключено');
      for (const [surface, levels] of materials) {
        if (!surface.trim() || !levels.length || levels.some(material => material.getScene() !== core.scene)) throw new Error('Некорректное оформление поверхности');
      }
      const connection = new Map(Array.from(materials, ([surface, levels]) => [surface, [...levels]]));
      surfaceMaterials = connection;
      owner.onDispose(() => { if (surfaceMaterials === connection) { surfaceMaterials = undefined; applyMaterials(connection); } });
      applyMaterials(undefined);
    }
    let stopped = false;
    scope.onDispose(() => {
      stopped = true;
      for (const model of models.keys()) model.dispose();
      models.clear();
    });

    function validateParts(parts: readonly GeometryPart[]) {
      if (stopped) throw new Error('Модуль геометрии остановлен');
      if (!parts.length) throw new Error('Нужна хотя бы одна деталь');
      for (const part of parts) {
        if(part.radialSegments!==undefined&&(!Number.isSafeInteger(part.radialSegments)||part.radialSegments<8||part.radialSegments>32||part.faceUV!==undefined))throw new Error('Некорректная радиальная деталь');
        if (!part.surface.trim() || part.size.length !== 3 || !part.size.every(value => Number.isFinite(value) && value > 0) ||
            [part.position, part.rotation].some(value => value !== undefined && (value.length !== 3 || !value.every(Number.isFinite))) ||
            (part.faceUV !== undefined && (part.faceUV.length !== 6 || part.faceUV.some(uv => uv.length !== 4 || !uv.every(value => Number.isFinite(value) && value >= 0 && value <= 1) || uv[0] >= uv[2] || uv[1] >= uv[3])))) {
          throw new Error('Некорректная поверхность, размер или преобразование детали');
        }
      }
    }

    function createModel(name: string, parts: readonly GeometryPart[], owner: Scope, detail = 0): GeometryModel {
      validateParts(parts);
      getSurfaceMaterial(parts[0].surface, detail);
      if (!name.trim()) throw new Error('Нужно имя модели');
      const root = new TransformNode(name, core.scene);
      owner.onDispose(() => root.dispose());
      root.onDisposeObservable.addOnce(() => models.delete(root));
      const surfaces = new Map<string, Mesh[]>();
      try {
        for (const part of parts) {
          // shortcut: clones share geometry but not draw calls, batch compatible variants in object-rendering.
          const mesh = (part.radialSegments?getRadialSource(part.radialSegments):getSource(part.faceUV)).clone(`${name}/${part.surface}`, root, true);
          if(part.radialSegments)mesh.metadata={radialFacade:true};
          mesh.isVisible = true;
          mesh.material = getSurfaceMaterial(part.surface, detail);
          mesh.scaling.copyFromFloats(...part.size);
          if (part.position) mesh.position.copyFromFloats(...part.position);
          if (part.rotation) mesh.rotation.copyFromFloats(...part.rotation);
          const group = surfaces.get(part.surface) ?? [];
          group.push(mesh);
          surfaces.set(part.surface, group);
        }
      } catch (error) { root.dispose(); throw error; }
      models.set(root, { surfaces, detail });
      return { root, surfaces };
    }
    function createSurfaceMesh(name: string, surface: string, positions: readonly number[], indices: readonly number[], owner: Scope, customUVs?: readonly number[]) {
      if (!name.trim() || !surface.trim() || positions.length<9 || positions.length%3 || positions.length>900000 || indices.length%3 || !indices.length || indices.length>1800000 || !positions.every(Number.isFinite) || !indices.every(i=>Number.isSafeInteger(i)&&i>=0&&i<positions.length/3)) throw new Error('Invalid surface geometry');
      if(customUVs && (customUVs.length!==positions.length/3*2||!customUVs.every(Number.isFinite)))throw new Error('Invalid surface UVs');
      const material=getSurfaceMaterial(surface);
      const mesh=new Mesh(name,core.scene);owner.onDispose(()=>mesh.dispose());
      try {
        const data=new VertexData();data.positions=new Float32Array(positions);
        data.indices=positions.length/3<=65536?Uint16Array.from(indices):Uint32Array.from(indices);
        const normals=new Float32Array(positions.length);VertexData.ComputeNormals(data.positions,data.indices,normals);data.normals=normals;
        const uvs=customUVs?new Float32Array(customUVs):new Float32Array(positions.length/3*2);
        if(!customUVs)for(let i=0,j=0;i<positions.length;i+=3){uvs[j++]=positions[i]/2;uvs[j++]=positions[i+2]/2;}
        data.uvs=uvs;
        data.applyToMesh(mesh);mesh.material=material;mesh.isPickable=false;mesh.metadata={fittedUV:customUVs!==undefined};
        const surfaces=new Map([[surface,[mesh]]]);models.set(mesh,{surfaces,detail:0});
        mesh.onDisposeObservable.addOnce(()=>models.delete(mesh));
        return mesh;
      } catch(error) {mesh.dispose();throw error;}
    }
    function registerMeshes(meshes: readonly Mesh[], owner: Scope) {
      if (stopped) throw new Error('Модуль геометрии остановлен');
      const list = [...meshes];
      if (!list.length || new Set(list).size !== list.length || list.some(mesh => mesh.isDisposed() || mesh.getScene() !== core.scene || borrowed.has(mesh))) throw new Error('Некорректные импортированные меши');
      for (const mesh of list) borrowed.add(mesh);
      owner.onDispose(() => { for (const mesh of list) borrowed.delete(mesh); });
    }
    return { createModel, createSurfaceMesh, validateParts, getSurfaceMaterial, registerSurfaceMaterials, registerMeshes,setMeshFade,
      *getMeshes() {
        if (stopped) throw new Error('Модуль геометрии остановлен');
        for (const { surfaces } of models.values()) for (const meshes of surfaces.values()) yield* meshes;
        for (const mesh of borrowed) if (!mesh.isDisposed()) yield mesh;
      },
    };
  },
});
