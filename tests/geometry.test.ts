import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { defineModule } from '../src/core/context.ts';
import { startModules, type Scope } from '../src/core/modules.ts';
import { createPanels } from '../src/core/panels.ts';
import { geometryModule } from '../src/modules/geometry/index.ts';

function fixture(t: TestContext) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  let api: ReturnType<typeof geometryModule.setup> | undefined;
  const consumer = defineModule({
    id: 'geometry-consumer', title: '', category: 'Тесты', requires: { geometry: geometryModule },
    setup({ deps }) { api = deps.geometry; return {}; },
  });
  const session = startModules([geometryModule, consumer], [consumer.id], { scene, onFrame: new Observable<number>(), panels: createPanels() });
  t.after(() => session.dispose());
  assert.ok(api);
  const cleanups: (() => void)[] = [];
  const owner: Scope = { onDispose: cleanup => cleanups.push(cleanup) };
  const disposeOwner = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
  t.after(disposeOwner);
  return { api, scene, session, owner, disposeOwner };
}

test('geometry models share buffers and group named surfaces without sharing transforms', t => {
  const { api, scene, owner, disposeOwner } = fixture(t);
  const parts = [
    { surface: 'walls', size: [2, 3, 4], position: [0, 1.5, 0] },
    { surface: 'walls', size: [1, 1, 1], position: [3, 1, 0] },
    { surface: 'roof', size: [3, 0.2, 5], rotation: [0, 0.5, 0] },
  ] satisfies Parameters<typeof api.createModel>[1];
  const a = api.createModel('a', parts, owner);
  const b = api.createModel('b', parts, owner);
  const wallA = a.surfaces.get('walls')?.[0];
  const wallB = b.surfaces.get('walls')?.[0];
  assert.ok(wallA && wallB);
  assert.equal(a.root.getChildMeshes().length, 3);
  assert.equal(a.surfaces.get('walls')?.length, 2);
  assert.equal(a.surfaces.get('roof')?.length, 1);
  assert.deepEqual(wallA.scaling.asArray(), [2, 3, 4]);
  assert.deepEqual(wallA.position.asArray(), [0, 1.5, 0]);
  assert.equal(a.surfaces.get('roof')?.[0].rotation.y, 0.5);
  assert.equal(wallA.geometry, wallB.geometry);
  assert.equal(scene.geometries.length, 1);
  assert.equal(scene.materials.length, 1);
  a.root.position.x = 8;
  a.root.dispose();
  assert.equal(wallA.isDisposed(), true);
  assert.equal(wallB.isDisposed(), false);
  assert.equal(b.root.position.x, 0);
  assert.ok(wallB.geometry?.getTotalVertices());
  disposeOwner();
  assert.equal(b.root.isDisposed(), true);
  assert.equal(scene.meshes.length, 1);
});

test('geometry validates before allocation and cleans models on stop or partial creation failure', t => {
  const { api, scene, session, owner } = fixture(t);
  const initialMeshes = scene.meshes.length;
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => api.createModel('invalid', [{ surface: 'body', size: [1, value, 1] }], owner));
  }
  assert.throws(() => api.createModel('', [{ surface: 'body', size: [1, 1, 1] }], owner));
  assert.throws(() => api.createModel('empty', [], owner));
  assert.throws(() => api.createModel('surface', [{ surface: ' ', size: [1, 1, 1] }], owner));
  assert.throws(() => api.createModel('position', [{ surface: 'body', size: [1, 1, 1], position: [0, NaN, 0] }], owner));
  assert.equal(scene.meshes.length, initialMeshes);
  assert.equal(scene.transformNodes.length, 0);

  const source = scene.meshes[0];
  assert.ok(source);
  const clone = source.clone.bind(source);
  let calls = 0;
  t.mock.method(source, 'clone', (...args: Parameters<typeof source.clone>) => {
    if (++calls === 2) throw new Error('clone failed');
    return clone(...args);
  });
  assert.throws(() => api.createModel('broken', [
    { surface: 'body', size: [1, 1, 1] }, { surface: 'roof', size: [2, 1, 2] },
  ], owner), /clone failed/);
  assert.equal(scene.transformNodes.length, 0);
  assert.equal(scene.meshes.length, initialMeshes);
  t.mock.restoreAll();

  const model = api.createModel('live', [{ surface: 'body', size: [1, 1, 1] }], owner);
  session.dispose();
  assert.equal(model.root.isDisposed(), true);
  assert.equal(scene.meshes.length, 0);
  assert.equal(scene.geometries.length, 0);
  assert.equal(scene.materials.length, 0);
  assert.throws(() => api.createModel('late', [{ surface: 'body', size: [1, 1, 1] }], owner), /остановлен/);
});
