import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { defineModule } from '../src/core/context.ts';
import { createPanels } from '../src/core/panels.ts';
import { startModules } from '../src/core/modules.ts';
import { geometryModule } from '../src/modules/geometry/index.ts';
import { objectTemplatesModule, type ObjectTemplate } from '../src/modules/object-templates/index.ts';
import { objectRenderingModule, type DistancePoint } from '../src/modules/object-rendering/index.ts';

const template: ObjectTemplate = {
  id: 'test-object', version: 1, parameters: {},
  build: () => ({ hideDistance: 30, levels: [
    { distance: 0, parts: [{ surface: 'body', size: [2, 2, 2] }] },
    { distance: 10, parts: [{ surface: 'body', size: [1, 1, 1] }] },
    { distance: 20, parts: [{ surface: 'body', size: [0.5, 0.5, 0.5] }] },
  ] }),
};

function ownerScope() {
  const cleanups: (() => void)[] = [];
  return {
    onDispose(cleanup: () => void) { cleanups.push(cleanup); },
    dispose() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); },
  };
}
function fixture(t: TestContext) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const owner = ownerScope();
  const camera = new FreeCamera('test-camera', new Vector3(0, 0, 0), scene);
  let api: ReturnType<typeof objectRenderingModule.setup> | undefined;
  let templates: ReturnType<typeof objectTemplatesModule.setup> | undefined;
  const consumer = defineModule({
    id: 'rendering-consumer', title: '', category: 'Тесты',
    requires: { rendering: objectRenderingModule, templates: objectTemplatesModule },
    setup({ deps }) { api = deps.rendering; templates = deps.templates; return {}; },
  });
  const session = startModules([geometryModule, objectTemplatesModule, objectRenderingModule, consumer], [consumer.id], {
    scene, onFrame: new Observable<number>(), panels: createPanels(),
  });
  t.after(() => { owner.dispose(); session.dispose(); scene.dispose(); engine.dispose(); });
  assert.ok(api && templates);
  templates.register(template, owner);
  return { api, templates, scene, camera, owner, session, frame: () => scene.onBeforeRenderObservable.notifyObservers(scene) };
}

test('rendering switches complete LODs at exact bounds distances and hides at hideDistance', t => {
  const { api, scene, camera, owner, frame } = fixture(t);
  const object = api.createObject(template.id, 'object', {}, owner);
  assert.equal(scene.meshes.length, 1);
  assert.equal(object.level(), null);
  const sequence: [number, number | null][] = [[0, 0], [10.99, 0], [11, 1], [21, 2], [31, null], [11, 1], [0, 0]];
  for (const [x, expected] of sequence) {
    camera.position.x = x;
    frame();
    assert.equal(object.level(), expected);
    const enabled = object.root.getChildMeshes().filter(mesh => mesh.isEnabled());
    assert.equal(enabled.length, expected === null ? 0 : 1);
    if (expected !== null) assert.ok(enabled[0].name.includes(`lod-${expected}`));
  }
  assert.equal(scene.meshes.length, 4);
  assert.equal(scene.geometries.length, 1);
  object.root.dispose();
  assert.equal(scene.meshes.length, 1);
  assert.equal(object.level(), null);
  frame();
  assert.equal(scene.meshes.length, 1);
});

test('distance bounds include all levels, part transforms, root scaling and parents', t => {
  const { api, templates, scene, camera, owner, frame } = fixture(t);
  templates.register({ ...template, id: 'large', build: () => ({ hideDistance: 30, levels: [
    { distance: 0, parts: [{ surface: 'near', size: [1, 1, 1] }] },
    { distance: 10, parts: [{ surface: 'far', size: [2, 2, 20], position: [10, 0, 0], rotation: [0, Math.PI / 2, 0] }] },
  ] }) }, owner);
  const object = api.createObject('large', 'large', {}, owner);
  const parent = new TransformNode('parent', scene);
  owner.onDispose(() => parent.dispose());
  parent.position.x = 100;
  object.root.parent = parent;
  object.root.scaling.set(2, 1, 1);
  object.root.rotation.y = Math.PI / 2;
  // Rotated far geometry extends to z=-40 in world coordinates.
  camera.position.set(100, 0, -49);
  frame();
  assert.equal(object.level(), 0);
  camera.position.z = -51;
  frame();
  assert.equal(object.level(), 1);
  parent.position.z = 20;
  frame();
  assert.equal(object.level(), null);
});

test('instances select LOD independently and disposing one preserves shared geometry', t => {
  const { api, scene, camera, owner, frame } = fixture(t);
  const a = api.createObject(template.id, 'a', {}, owner);
  const b = api.createObject(template.id, 'b', {}, owner);
  b.root.position.x = 100;
  frame();
  assert.equal(a.level(), 0);
  assert.equal(b.level(), null);
  camera.position.x = 100;
  frame();
  assert.equal(a.level(), null);
  assert.equal(b.level(), 0);
  assert.equal(scene.geometries.length, 1);
  a.root.dispose();
  frame();
  assert.equal(b.level(), 0);
  assert.ok(b.root.getChildMeshes()[0].getTotalVertices());
  assert.equal(scene.meshes.length, 2);
});

test('new model notifications run once per visited LOD and callback failure cleans the instance', t => {
  const { api, scene, camera, owner, frame } = fixture(t);
  const object = api.createObject(template.id, 'styled', {}, owner);
  let notifications = 0;
  object.onModelCreated.add(model => { notifications++; assert.ok(model.surfaces.has('body')); });
  frame();
  camera.position.x = 11;
  frame();
  camera.position.x = 0;
  frame();
  assert.equal(notifications, 2);
  object.root.dispose();
  assert.equal(object.onModelCreated.hasObservers(), false);
  const broken = api.createObject(template.id, 'broken', {}, owner);
  broken.onModelCreated.add(() => { throw new Error('styling failed'); });
  assert.throws(frame, /styling failed/);
  assert.equal(broken.root.isDisposed(), true);
  assert.equal(scene.meshes.length, 1);
});

test('explicit hero source overrides world camera position and missing hero never falls back', t => {
  const { api, scene, camera, owner, frame } = fixture(t);
  const object = api.createObject(template.id, 'object', {}, owner);
  const cameraParent = new TransformNode('camera-parent', scene);
  owner.onDispose(() => cameraParent.dispose());
  camera.parent = cameraParent;
  cameraParent.position.x = 31;
  frame();
  assert.equal(object.level(), null);
  assert.equal(api.getDistanceOrigin()?.x, 31);
  let hero: DistancePoint | null = { x: 0, y: 0, z: 0 };
  const connection = ownerScope();
  t.after(() => connection.dispose());
  api.setDistanceSource(() => hero, connection);
  assert.throws(() => api.setDistanceSource(() => null, owner), /уже подключён/);
  frame();
  assert.equal(object.level(), 0);
  hero = null;
  frame();
  assert.equal(object.level(), null);
  assert.equal(api.getDistanceOrigin(), null);
  hero = { x: NaN, y: 0, z: 0 };
  assert.throws(() => api.getDistanceOrigin(), /конечные координаты/);
  connection.dispose();
  frame();
  assert.equal(object.level(), null);
  camera.parent = null;
  frame();
  assert.equal(object.level(), 0);
  scene.activeCamera = null;
  frame();
  assert.equal(object.level(), null);
});

test('cleanup releases objects and observers; invalid creation allocates no object resources', t => {
  const { api, templates, scene, owner, session, frame } = fixture(t);
  const count = scene.transformNodes.length;
  assert.throws(() => api.createObject('missing', 'object', {}, owner));
  assert.throws(() => api.createObject(template.id, ' ', {}, owner));
  assert.throws(() => api.createObject(template.id, 'object', { unknown: 1 }, owner));
  templates.register({ ...template, id: 'overflow', build: () => ({ hideDistance: 10, levels: [
    { distance: 0, parts: [{ surface: 'body', size: [1e100, 1, 1] }] },
  ] }) }, owner);
  assert.throws(() => api.createObject('overflow', 'overflow', {}, owner), /Границы/);
  assert.equal(scene.transformNodes.length, count);
  assert.equal(scene.meshes.length, 1);
  const object = api.createObject(template.id, 'object', {}, owner);
  frame();
  assert.equal(scene.meshes.length, 2);
  object.root.position.x = NaN;
  assert.throws(frame, /Преобразование/);
  session.dispose();
  assert.equal(object.root.isDisposed(), true);
  assert.equal(scene.meshes.length, 0);
  assert.equal(scene.onBeforeRenderObservable.hasObservers(), false);
  assert.doesNotThrow(frame);
  assert.equal(session.tests.length, 0);
  assert.throws(() => api.getDistanceOrigin(), /остановлен/);
  assert.throws(() => api.createObject(template.id, 'late', {}, owner), /остановлен/);
  assert.throws(() => api.setDistanceSource(() => null, owner), /остановлен/);
});

test('static objects skip distant LOD work and retain cached transforms until explicitly refreshed', t => {
  const { api, scene, camera, owner, frame } = fixture(t);
  const object = api.createObject(template.id, 'static', {}, owner, 'static');
  frame();
  assert.equal(object.level(), 0);
  assert.equal(api.getStats().boundsUpdates, 1);
  const compute = t.mock.method(object.root, 'computeWorldMatrix');
  for (const x of [1024, -1024, 0]) {
    camera.position.x = x;
    frame();
    assert.equal(object.level(), x === 0 ? 0 : null);
    assert.equal(api.getStats().candidates, x === 0 ? 1 : 0);
    assert.equal(api.getStats().boundsUpdates, 0);
  }
  assert.equal(compute.mock.calls.length, 0);
  object.root.position.x = 2048;
  object.refreshTransform();
  camera.position.x = 2048;
  frame();
  assert.equal(object.level(), 0);
  assert.equal(api.getStats().boundsUpdates, 1);
  object.root.dispose();
  assert.throws(() => object.refreshTransform(), /удалён/);
  assert.equal(api.getStats().objects, 0);
  assert.equal(api.getStats().cells, 0);
  frame();
  assert.equal(scene.meshes.length, 1);
});

test('dynamic objects cross cells and reparent without stale bounds or unnecessary recomputation', t => {
  const { api, scene, camera, owner, frame } = fixture(t);
  const object = api.createObject(template.id, 'moving', {}, owner);
  object.root.position.x = 2048;
  frame();
  assert.equal(object.level(), null);
  object.root.position.x = 0;
  frame();
  assert.equal(object.level(), 0);
  assert.equal(api.getStats().boundsUpdates, 1);
  frame();
  assert.equal(api.getStats().boundsUpdates, 0);
  const parent = new TransformNode('moving-parent', scene);
  owner.onDispose(() => parent.dispose());
  parent.position.x = -2048;
  object.root.parent = parent;
  camera.position.x = -2048;
  frame();
  assert.equal(object.level(), 0);
  parent.position.x = 0;
  frame();
  assert.equal(object.level(), null);
  object.root.parent = null;
  object.root.position.x = 4096;
  object.root.computeWorldMatrix(true);
  camera.position.x = 4096;
  frame();
  assert.equal(object.level(), 0);
  const reused = new Vector3(0, 0, 0);
  const other = new TransformNode('other', scene);
  owner.onDispose(() => other.dispose());
  other.position = reused;
  other.computeWorldMatrix(true);
  object.root.position = reused;
  camera.position.x = 0;
  frame();
  assert.equal(object.level(), 0);
});

test('cell selection respects individual distances and oversized object edges', t => {
  const { api, templates, camera, owner, frame } = fixture(t);
  templates.register({ ...template, id: 'long-range', build: () => ({ ...template.build({}), hideDistance: 400 }) }, owner);
  const near = api.createObject(template.id, 'short', {}, owner, 'static');
  const far = api.createObject('long-range', 'long', {}, owner, 'static');
  near.root.position.x = 300;
  far.root.position.x = 300;
  frame();
  assert.equal(near.level(), null);
  assert.equal(far.level(), 2);
  assert.equal(api.getStats().candidates, 1);
  camera.position.x = 300;
  frame();
  assert.equal(near.level(), 0);
  assert.equal(far.level(), 0);
  templates.register({ ...template, id: 'huge', build: () => ({ hideDistance: 30, levels: [
    { distance: 0, parts: [{ surface: 'body', size: [100000, 2, 2] }] },
  ] }) }, owner);
  const huge = api.createObject('huge', 'huge', {}, owner, 'static');
  camera.position.set(50001, 0, 0);
  frame();
  assert.equal(huge.level(), 0);
  assert.equal(near.level(), null);
  camera.position.z = 100;
  frame();
  assert.equal(huge.level(), null);
  huge.root.dispose();
  frame();
  assert.equal(api.getStats().candidates, 0);
});

test('disposing during model notification removes the object from active cells', t => {
  const { api, scene, owner, frame } = fixture(t);
  const object = api.createObject(template.id, 'ephemeral', {}, owner, 'static');
  object.onModelCreated.add(() => object.root.dispose());
  frame(); frame();
  assert.equal(api.getStats().objects, 0);
  assert.equal(api.getStats().cells, 0);
  assert.equal(api.getStats().candidates, 0);
  assert.equal(scene.meshes.length, 1);
});

test('spatial selection matches direct box distances across positive and negative cell boundaries', t => {
  const { api, camera, owner, frame } = fixture(t);
  const positions = [-256, -129, -1, 128, 300];
  const objects = positions.map(x => {
    const object = api.createObject(template.id, `at-${x}`, {}, owner, 'static');
    object.root.position.x = x;
    return object;
  });
  for (const x of [-384, -257, -256, -130, -129, -128, -1, 0, 127, 128, 129, 299, 300, 331, 4096]) {
    for (const z of [-31, 0, 31]) {
      camera.position.set(x, 0, z);
      frame();
      for (let index = 0; index < objects.length; index++) {
        const distance = Math.hypot(Math.max(Math.abs(x - positions[index]) - 1, 0), Math.max(Math.abs(z) - 1, 0));
        const expected = distance >= 30 ? null : distance >= 20 ? 2 : distance >= 10 ? 1 : 0;
        assert.equal(objects[index].level(), expected, `${positions[index]} viewed from ${x}/${z}`);
      }
    }
  }
});
