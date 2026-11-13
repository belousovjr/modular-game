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
