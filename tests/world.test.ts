import { FACADE_PATCH } from '../src/modules/materials/surface-scale.ts';
import { createScope } from '../src/core/scope.ts';
import { createLighting } from '../src/modules/lighting/light.ts';
import { createShadows } from '../src/modules/shadows/resources.ts';
import type { DistancePoint } from '../src/modules/object-rendering/index.ts';
import { readFileSync } from 'node:fs';
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
import { worldStreamingModule } from '../src/modules/world-streaming/index.ts';
import { worldModule } from '../src/modules/world/index.ts';

test('world places persistent generated content, keeps fallback styling without materials and releases all resources on restart', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const camera = new ArcRotateCamera('camera', -Math.PI / 2, 0.9, 25, Vector3.Zero(), scene);
  camera.upperRadiusLimit = 35;
  const core = { scene, onFrame: new Observable<number>(), panels: createPanels() };
  let rendering: ReturnType<typeof objectRenderingModule.setup> | undefined;
  let geometry: ReturnType<typeof geometryModule.setup> | undefined;
  let api: ReturnType<typeof worldModule.setup> | undefined;
  const probe = defineModule({ id: 'probe', category: 'Тесты', title: '', requires: { world: worldModule, templates: objectTemplatesModule, rendering: objectRenderingModule, geometry: geometryModule }, setup({ deps }) {
    api = deps.world; rendering = deps.rendering; geometry = deps.geometry;
    const lamp = deps.templates.resolve('world/lamp');
    assert.equal(lamp.hideDistance, 40);
    assert.deepEqual(lamp.levels.map(level => [level.distance, level.parts.length]), [[0, 4], [8, 1]]);
    for (const height of [8, 27]) {
      const building = deps.templates.resolve('world/building', { height });
      assert.deepEqual(building.levels.map(level => level.parts.length), [5, 3, 1]);
      assert.deepEqual(building.levels.map(level => level.distance), [0, 8, 22]);
      assert.equal(building.hideDistance, 120);
      assert.ok(building.levels.every(level => level.parts[0].surface === 'building-shell' && level.parts[0].faceUV?.length === 6));
      const nearUV = building.levels[0].parts[0].faceUV;
      const middleUV = building.levels[1].parts[0].faceUV;
      const farUV = building.levels[2].parts[0].faceUV;
      assert.deepEqual(nearUV, middleUV);
      assert.deepEqual(middleUV, farUV);
      assert.equal(building.levels[1].parts.some(part => part.surface === 'facade'), false);
      assert.notDeepEqual(building.levels[2].parts[0].faceUV?.[4], building.levels[2].parts[0].faceUV?.[0]);
      const facade = building.levels[0].parts.find(part => part.surface === 'facade');
      assert.ok(facade?.position);
      assert.ok(Math.abs(FACADE_PATCH.width - facade.size[0] / building.levels[0].parts[0].size[0]) < 1e-9);
      assert.ok(Math.abs(FACADE_PATCH.height - facade.size[1] / height) < 1e-9);
      assert.ok(Math.abs(FACADE_PATCH.center - facade.position[1] / height) < 1e-9);
      for (const size of [128, 32]) {
        const atlas = readFileSync(new URL(`../public/textures/city/building-shell-${size}.svg`, import.meta.url), 'utf8');
        for (const [key, ratio] of Object.entries({ width: facade.size[0] / building.levels[0].parts[0].size[0], height: facade.size[1] / height, center: facade.position[1] / height })) {
          const encoded = atlas.match(new RegExp(`data-facade-${key}=\"([0-9.]+)\"`));
          assert.ok(encoded);
          assert.ok(Math.abs(Number(encoded[1]) - ratio) < 1e-9);
        }
      }
      assert.equal(building.levels[0].parts.filter(part => part.surface === 'facade').length, 2);
      assert.equal(building.levels.some(level => level.parts.some(part => part.surface === 'windows')), false);
    }
    assert.equal(deps.templates.resolve('world/curb').hideDistance, 20);
    assert.equal(deps.templates.resolve('world/sidewalk').hideDistance, 100);
    assert.equal(deps.templates.resolve('world/road').hideDistance, 150);
    return {};
  } });
  const registry = [geometryModule, objectTemplatesModule, objectRenderingModule, worldGenerationModule, worldStreamingModule, worldModule, probe];
  for (let repeat = 0; repeat < 2; repeat++) {
    const session = startModules(registry, ['probe'], core);
    t.after(() => session.dispose());
    assert.ok(session.ids.includes('world-generation'));
    for (let frame = 0; frame < 180; frame++) scene.onBeforeRenderObservable.notifyObservers(scene);
    assert.ok(scene.transformNodes.length > 100);
    const before = scene.meshes.length;
    const scenario = session.tests.find(item => item.id === 'world');
    assert.ok(scenario);
    const cleanups: (() => void)[] = [];
    const diagnostics: Readonly<Record<string, number>>[] = [];
    const update = scenario.setup({ onDispose: cleanup => cleanups.push(cleanup) }, values => diagnostics.push(values));
    assert.ok(api);
    assert.equal(api.regions.length, 224);
    assert.equal(new Set(api.regions.map(region => region.id)).size, 224);
    assert.equal(api.regions.reduce((sum, region) => sum + region.objectCount, 0), api.objectCount);
    assert.ok(api.visibility().buildings >= 600);
    for (let step = 0; step <= 24; step++) {
      update(step / 24);
      scene.onBeforeRenderObservable.notifyObservers(scene);
      scene.onAfterRenderObservable.notifyObservers(scene);
    }
    assert.ok(before > 0 && scene.meshes.length > 0);
    const surfaces = scene.meshes.filter(mesh => mesh.name.includes('/lod-'));
    assert.ok(surfaces.length > 0);
    assert.ok(scene.meshes.some(m=>m.metadata?.citySurface==='city-stone'));
    assert.ok(scene.meshes.some(m=>m.metadata?.citySurface==='city-glass'));
    assert.ok(surfaces.every(mesh => mesh.material?.name === 'geometry-fallback'));
    for (const cleanup of cleanups.reverse()) cleanup();
    assert.equal(diagnostics.length, 1);
    assert.ok(diagnostics[0].hiddenFractionMin >= 0 && diagnostics[0].hiddenFractionMin < 1);
    assert.ok(diagnostics[0].hiddenFractionMax <= 1);
    assert.ok(diagnostics[0].reducedLampsMax > 0);
    assert.ok(diagnostics[0].hiddenLampsMin / diagnostics[0].lamps > 0.5);
    assert.ok(diagnostics[0].lodCandidatesMax < diagnostics[0].objects);
    assert.ok(diagnostics[0].boundsUpdatesMax >= 0);
    assert.ok(diagnostics[0].loadedSectionsMax > 0);
    assert.ok(scene.meshes.some(m=>m.metadata?.citySurface==='road'));
    assert.ok(scene.meshes.some(m=>m.metadata?.citySurface==='urban-ground'));
    assert.equal(camera.upperRadiusLimit, 35);
    assert.ok(scene.transformNodes.length > 100);
    assert.ok(rendering && geometry);
    const travel = createScope();
    t.after(() => travel.dispose());
    let point: DistancePoint | null = { x: 0, y: 10, z: 0 };
    rendering.setDistanceSource(() => point, travel);
    const light = createLighting(scene, travel);
    const shadows = createShadows(scene, light.getSunLight(), geometry.getMeshes, rendering.getDistanceOrigin, travel);
    const settle = () => { for (let frame = 0; frame < 180; frame++) scene.onBeforeRenderObservable.notifyObservers(scene); };
    const counts = () => ({ roots: scene.transformNodes.length, meshes: scene.meshes.length, geometries: scene.geometries.length,
      sections: api?.streaming().loaded, casters: shadows.getStats().casters, objects: rendering?.getStats().objects });
    point = null; settle();
    assert.equal(rendering.getStats().objects, 0);
    assert.equal(shadows.getStats().casters, 0);
    point = { x: 0, y: 10, z: 0 }; settle();
    const steady = counts();
    if (repeat === 0) t.diagnostic(`Streaming steady resources: ${JSON.stringify(steady)}`);
    assert.ok(rendering.getStats().objects < api.objectCount);
    assert.ok(shadows.getStats().casters > 0);
    assert.equal(rendering.getStats().boundsUpdates, 0);
    for (let trip = 0; trip < 3; trip++) {
      for (const [x, z] of [[-440, -440], [440, -440], [440, 440], [-440, 440]]) {
        point = { x, y: 10, z }; settle();
        assert.ok(rendering.getStats().objects < api.objectCount);
        assert.ok(light.getSunLight().getShadowGenerator()?.getShadowMap()?.renderList?.every(mesh => !mesh.isDisposed()));
      }
      point = null; settle();
      assert.equal(rendering.getStats().objects, 0);
      assert.equal(shadows.getStats().casters, 0);
      assert.equal(scene.transformNodes.length, 0);
      point = { x: 0, y: 10, z: 0 }; settle();
      assert.deepEqual(counts(), steady);
    }
    assert.ok(api.streaming().unloads > 0);
    travel.dispose();
    session.dispose();
    assert.equal(scene.meshes.length, 0);
    assert.equal(scene.geometries.length, 0);
    assert.equal(scene.transformNodes.length, 0);
    assert.equal(scene.materials.length, 0);
    assert.equal(scene.onBeforeRenderObservable.hasObservers(), false);
  }
});

test('distant ground batches preserve canonical geometry and avoid per-tile draws',async()=>{
  const {groupDistantSurfaces,distantSurfaces}=await import('../src/modules/world/distant-surfaces.ts');
  const {citySource}=await import('../src/modules/world/city.ts');
  const groups=groupDistantSurfaces(citySource);
  assert.ok(groups.length<=24);
  for(const surface of distantSurfaces){
    const source=citySource.chunks.flatMap(c=>c.meshes.filter(m=>m.surface===surface)),batches=groups.filter(g=>g.surface===surface);
    assert.equal(batches.reduce((n,m)=>n+m.positions.length,0),source.reduce((n,m)=>n+m.positions.length,0));
    assert.equal(batches.reduce((n,m)=>n+m.indices.length,0),source.reduce((n,m)=>n+m.indices.length,0));
    for(const batch of batches)assert.ok(batch.indices.every(i=>i>=0&&i<batch.positions.length/3));
  }
  const chunk=citySource.chunks[0];
  const triangle={surface:'water',positions:[0,0,0,1,0,0,0,0,1],indices:[0,1,2]};
  const paired=groupDistantSurfaces({...citySource,chunks:[{...chunk,meshes:[triangle,{...triangle,positions:triangle.positions.map((v,i)=>i%3===0?v+2:v)}]}]});
  assert.deepEqual(paired[0].indices,[0,1,2,3,4,5]);
  assert.ok(!distantSurfaces.has('curb')&&!distantSurfaces.has('marking'));
});
