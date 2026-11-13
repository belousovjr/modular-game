import '@babylonjs/core/Meshes/thinInstanceMesh.js';
import { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { Material } from '@babylonjs/core/Materials/material.js';
import type { GeometryModel, GeometryPart } from '../geometry/index.ts';
import type { Scope } from '../../core/modules.ts';

export function createSurfaceBatches(createModel: (name: string, parts: readonly GeometryPart[], owner: Scope) => GeometryModel, scope: Scope) {
  const batches = new Map<string, { model: GeometryModel; matrices: Map<object, Matrix>; buffer: Float32Array }>();
  const dirty = new Set<string>();
  function remove(key: string, token: object) {
    const batch = batches.get(key);
    if (!batch?.matrices.delete(token)) return;
    if (!batch.matrices.size) {
      batch.model.root.dispose();
      batches.delete(key);
      dirty.delete(key);
    } else dirty.add(key);
  }
  return {
    remove,
    set(key: string, token: object, matrix: Matrix, material: Material) {
      let batch = batches.get(key);
      if (!batch) {
        const model = createModel(`surface-batch/${key}`, [{ surface: 'batch', size: [1, 1, 1] }], scope);
        model.root.setEnabled(false);
        for (const meshes of model.surfaces.values()) for (const mesh of meshes) {
          // Thin-instance attributes live on Geometry: each batch needs its own buffers.
          mesh.makeGeometryUnique();
          mesh.material = material;
        }
        batch = { model, matrices: new Map(), buffer: new Float32Array(0) };
        batches.set(key, batch);
      }
      batch.matrices.set(token, matrix);
      dirty.add(key);
    },
    flush() {
      for (const key of dirty) {
        const batch = batches.get(key);
        if (!batch) continue;
        const required = batch.matrices.size * 16;
        const grew = batch.buffer.length < required;
        if (grew) batch.buffer = new Float32Array(Math.max(required, batch.buffer.length * 2));
        const buffer = batch.buffer;
        let offset = 0;
        for (const matrix of batch.matrices.values()) { matrix.copyToArray(buffer, offset); offset += 16; }
        for (const meshes of batch.model.surfaces.values()) for (const mesh of meshes) {
          if (grew) mesh.thinInstanceSetBuffer('matrix', buffer, 16, false);
          mesh.thinInstanceCount = batch.matrices.size;
          if (!grew) mesh.thinInstanceBufferUpdated('matrix');
          mesh.thinInstanceRefreshBoundingInfo();
        }
        batch.model.root.setEnabled(true);
      }
      dirty.clear();
    },
    stats() { return { batches: batches.size, batchedInstances: Array.from(batches.values()).reduce((sum, batch) => sum + batch.matrices.size, 0) }; },
  };
}
