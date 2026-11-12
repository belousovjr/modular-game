import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { defineModule } from '../src/core/context.ts';
import { startModules, type Scope } from '../src/core/modules.ts';
import { createPanels } from '../src/core/panels.ts';
import { geometryModule } from '../src/modules/geometry/index.ts';
import { objectTemplatesModule, type ObjectTemplate, type TemplateContent } from '../src/modules/object-templates/index.ts';

const building: ObjectTemplate = {
  id: 'test-building', version: 1,
  parameters: { height: { default: 4, min: 2, max: 12 } },
  build({ height }) {
    return { hideDistance: 100, levels: [
      { distance: 0, parts: [
        { surface: 'walls', size: [3, height, 3], position: [0, height / 2, 0] },
        { surface: 'roof', size: [4, 0.2, 4], position: [0, height + 0.1, 0] },
      ] },
      { distance: 40, parts: [{ surface: 'walls', size: [3, height, 3], position: [0, height / 2, 0] }] },
    ] };
  },
};
const pole: ObjectTemplate = {
  id: 'test-pole', version: 1, parameters: {},
  build: () => ({ hideDistance: 60, levels: [{ distance: 0, parts: [{ surface: 'body', size: [0.2, 3, 0.2] }] }] }),
};

function fixture(t: TestContext) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  let api: ReturnType<typeof objectTemplatesModule.setup> | undefined;
  const consumer = defineModule({
    id: 'template-consumer', title: '', category: 'Тесты', requires: { templates: objectTemplatesModule },
    setup({ deps }) { api = deps.templates; return {}; },
  });
  const session = startModules([geometryModule, objectTemplatesModule, consumer], [consumer.id], {
    scene, onFrame: new Observable<number>(), panels: createPanels(),
  });
  const cleanups: (() => void)[] = [];
  const owner: Scope = { onDispose: cleanup => cleanups.push(cleanup) };
  const disposeOwner = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
  t.after(() => { disposeOwner(); session.dispose(); scene.dispose(); engine.dispose(); });
  assert.ok(api);
  return { api, scene, session, owner, disposeOwner };
}

test('templates resolve parameters and all LOD descriptions without creating scene content', t => {
  const { api, scene, owner } = fixture(t);
  assert.deepEqual(api.list(), []);
  api.register(building, owner);
  api.register(pole, owner);
  assert.deepEqual(api.list(), [{ id: building.id, version: 1 }, { id: pole.id, version: 1 }]);
  const resolved = api.resolve(building.id);
  assert.equal(resolved.parameters.height, 4);
  assert.deepEqual(resolved.levels.map(level => level.distance), [0, 40]);
  assert.equal(resolved.hideDistance, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(resolved)), resolved);
  assert.equal(scene.meshes.length, 1);
  assert.equal(scene.transformNodes.length, 0);

  const a = api.createModel(building.id, 'a', { height: 8 }, owner);
  const b = api.createModel(building.id, 'b', {}, owner, 1);
  const post = api.createModel(pole.id, 'post', {}, owner);
  assert.equal(a.model.root.getChildMeshes().length, 2);
  assert.equal(b.model.root.getChildMeshes().length, 1);
  assert.equal(post.model.root.getChildMeshes().length, 1);
  const wallA = a.model.surfaces.get('walls')?.[0];
  const wallB = b.model.surfaces.get('walls')?.[0];
  assert.ok(wallA && wallB);
  assert.equal(wallA.scaling.y, 8);
  assert.equal(wallB.scaling.y, 4);
  assert.equal(wallA.geometry, wallB.geometry);
  a.model.root.dispose();
  assert.equal(wallB.isDisposed(), false);
});

test('invalid templates, parameters and LODs are rejected before geometry allocation', t => {
  const { api, scene, owner } = fixture(t);
  api.register(building, owner);
  assert.throws(() => api.register(building, owner), /уже зарегистрирован/);
  assert.throws(() => api.resolve('missing'), /Неизвестный шаблон/);
  assert.throws(() => api.resolve(building.id, { width: 2 }), /Неизвестный параметр/);
  for (const height of [NaN, Infinity, -Infinity, 0, 13]) {
    assert.throws(() => api.createModel(building.id, 'invalid', { height }, owner), /параметра/);
  }
  for (const level of [-1, 0.5, NaN, 2]) {
    assert.throws(() => api.createModel(building.id, 'invalid', {}, owner, level), /уровень/);
  }
  const valid = pole.build({});
  const part = valid.levels[0].parts;
  const badContent: TemplateContent[] = [
    { ...valid, hideDistance: Infinity }, { ...valid, hideDistance: 0 },
    { ...valid, levels: [] }, { ...valid, levels: [{ distance: 1, parts: part }] },
    { ...valid, levels: [{ distance: 0, parts: part }, { distance: 0, parts: part }] },
    { ...valid, levels: [{ distance: 0, parts: part }, { distance: NaN, parts: part }] },
    { ...valid, levels: [{ distance: 0, parts: part }, { distance: 60, parts: part }] },
    { ...valid, levels: [{ distance: 0, parts: part }, { distance: 20, parts: [] }] },
  ];
  for (const content of badContent) {
    assert.throws(() => api.register({ ...pole, build: () => content }, owner));
  }
  for (const version of [0, 1.5, Infinity]) assert.throws(() => api.register({ ...pole, version }, owner));
  assert.throws(() => api.register({ ...pole, id: ' ' }, owner));
  assert.throws(() => api.register({ ...pole, parameters: { height: { default: 4, min: 5, max: 2 } } }, owner));
  assert.throws(() => api.register({ ...pole, parameters: { height: { default: NaN, min: 1, max: 5 } } }, owner));
  api.register({ ...pole, parameters: { size: { default: 1, min: -1, max: 1 } }, build: ({ size }) => ({
    hideDistance: 10, levels: [{ distance: 0, parts: [{ surface: 'body', size: [size, 1, 1] }] }],
  }) }, owner);
  assert.throws(() => api.createModel(pole.id, 'invalid-size', { size: -1 }, owner));
  assert.equal(scene.meshes.length, 1);
  assert.equal(scene.transformNodes.length, 0);
});

test('catalog snapshots and registration lifetimes are isolated; shutdown clears resources', t => {
  const { api, scene, owner, session } = fixture(t);
  const cleanups: (() => void)[] = [];
  const registration: Scope = { onDispose: cleanup => cleanups.push(cleanup) };
  const rule = { default: 4, min: 2, max: 12 };
  const content = pole.build({});
  api.register({ ...pole, parameters: { height: rule }, build: () => content }, registration);
  rule.default = 100;
  assert.equal(api.resolve(pole.id).parameters.height, 4);
  const snapshot = api.resolve(pole.id);
  assert.notEqual(snapshot.levels[0].parts, content.levels[0].parts);
  assert.notEqual(snapshot.levels[0].parts[0].size, content.levels[0].parts[0].size);
  const instance = api.createModel(pole.id, 'post', {}, owner);
  cleanups[0]();
  assert.deepEqual(api.list(), []);
  assert.equal(instance.model.root.isDisposed(), false);
  api.register({ ...pole, version: 2 }, owner);
  cleanups[0]();
  assert.equal(api.resolve(pole.id).version, 2);
  assert.equal(session.tests.length, 0);
  session.dispose();
  assert.equal(instance.model.root.isDisposed(), true);
  assert.equal(scene.meshes.length, 0);
  assert.throws(() => api.resolve(pole.id), /остановлен/);
  assert.throws(() => api.register(pole, owner), /остановлен/);
  assert.throws(() => api.list(), /остановлен/);
});
