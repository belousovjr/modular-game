import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { createPanels } from '../src/core/panels.ts';
import { startModules } from '../src/core/modules.ts';
import { defineModule } from '../src/core/context.ts';
import { geometryModule } from '../src/modules/geometry/index.ts';
import { objectTemplatesModule } from '../src/modules/object-templates/index.ts';
import { objectRenderingModule } from '../src/modules/object-rendering/index.ts';
import { worldGenerationModule } from '../src/modules/world-generation/index.ts';
import { worldModule } from '../src/modules/world/index.ts';

test('world places persistent generated content, styles every new LOD and releases all resources on restart', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const camera = new ArcRotateCamera('camera', -Math.PI / 2, 0.9, 25, Vector3.Zero(), scene);
  camera.upperRadiusLimit = 35;
  const core = { scene, onFrame: new Observable<number>(), panels: createPanels() };
  let api: ReturnType<typeof worldModule.setup> | undefined;
  const probe = defineModule({ id: 'probe', category: 'Тесты', title: '', requires: { world: worldModule, templates: objectTemplatesModule }, setup({ deps }) {
    api = deps.world;
    const lamp = deps.templates.resolve('world/lamp');
    assert.equal(lamp.hideDistance, 40);
    assert.deepEqual(lamp.levels.map(level => [level.distance, level.parts.length]), [[0, 4], [8, 1]]);
    for (const height of [8, 27]) {
      const building = deps.templates.resolve('world/building', { height });
      assert.deepEqual(building.levels.map(level => level.parts.length), [5, 3, 1]);
      assert.deepEqual(building.levels.map(level => level.distance), [0, 8, 22]);
      assert.equal(building.hideDistance, 120);
      assert.equal(building.levels[0].parts.filter(part => part.surface === 'facade').length, 2);
      assert.equal(building.levels.some(level => level.parts.some(part => part.surface === 'windows')), false);
    }
    assert.equal(deps.templates.resolve('world/curb').hideDistance, 20);
    assert.equal(deps.templates.resolve('world/sidewalk').hideDistance, 100);
    assert.equal(deps.templates.resolve('world/road').hideDistance, 150);
    return {};
  } });
  const registry = [geometryModule, objectTemplatesModule, objectRenderingModule, worldGenerationModule, worldModule, probe];
  for (let repeat = 0; repeat < 2; repeat++) {
    const session = startModules(registry, ['probe'], core);
    t.after(() => session.dispose());
    assert.ok(session.ids.includes('world-generation'));
    assert.ok(scene.transformNodes.length > 100);
    scene.onBeforeRenderObservable.notifyObservers(scene);
    const before = scene.meshes.length;
    const scenario = session.tests.find(item => item.id === 'world');
    assert.ok(scenario);
    const cleanups: (() => void)[] = [];
    const diagnostics: Readonly<Record<string, number>>[] = [];
    const update = scenario.setup({ onDispose: cleanup => cleanups.push(cleanup) }, values => diagnostics.push(values));
    assert.ok(api);
    assert.ok(api.visibility().buildings >= 1000);
    for (let step = 0; step <= 24; step++) {
      update(step / 24);
      scene.onBeforeRenderObservable.notifyObservers(scene);
      scene.onAfterRenderObservable.notifyObservers(scene);
    }
    assert.ok(scene.meshes.length >= before);
    const surfaces = scene.meshes.filter(mesh => mesh.name.includes('/lod-'));
    assert.ok(surfaces.length > 100);
    assert.ok(surfaces.every(mesh => mesh.material?.name.startsWith('world-')));
    for (const cleanup of cleanups.reverse()) cleanup();
    assert.equal(diagnostics.length, 1);
    assert.ok(diagnostics[0].hiddenFractionMin >= 0.93);
    assert.ok(diagnostics[0].hiddenFractionMax <= 0.99);
    assert.ok(diagnostics[0].reducedLampsMax > 0);
    assert.ok(diagnostics[0].hiddenLampsMin / diagnostics[0].lamps > 0.95);
    assert.ok(diagnostics[0].lodCandidatesMax < diagnostics[0].objects);
    assert.equal(diagnostics[0].boundsUpdatesMax, 0);
    assert.equal(camera.upperRadiusLimit, 35);
    assert.ok(scene.transformNodes.length > 100);
    session.dispose();
    assert.equal(scene.meshes.length, 0);
    assert.equal(scene.geometries.length, 0);
    assert.equal(scene.transformNodes.length, 0);
    assert.equal(scene.materials.length, 0);
    assert.equal(scene.onBeforeRenderObservable.hasObservers(), false);
  }
});
