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
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
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
import { citySource } from '../src/modules/world/city.ts';

test('world places persistent generated content, keeps fallback styling without materials and releases all resources on restart', t => {
  const engine = new NullEngine();engine.getDeltaTime=()=>16;
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
    assert.deepEqual(lamp.levels.map(level => [level.distance, level.parts.length]), [[0, 4], [8, 3]]);
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
    assert.equal(api.regions.length, citySource.chunks.length);
    assert.ok(Object.isFrozen(api.streetLights)&&api.streetLights.length>100);
    assert.ok(api.streetLights.every(l=>Object.isFrozen(l)&&l.street.length>0&&[l.x,l.y,l.z].every(Number.isFinite)));
    assert.equal(new Set(api.regions.map(region => region.id)).size, citySource.chunks.length);
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
    point = { x:24, y:3, z:-60 }; settle();
    const treeProxies=scene.meshes.filter(mesh=>mesh.metadata?.treeShadow&&mesh.isEnabled());
    const treeCasters=light.getSunLight().getShadowGenerator()?.getShadowMap()?.renderList??[];
    assert.ok(treeProxies.length>0);
    assert.ok(treeProxies.every(mesh=>mesh.layerMask===0&&!mesh.receiveShadows&&mesh.metadata?.shadowFeather===.80&&treeCasters.includes(mesh)));
    assert.ok(treeCasters.every(mesh=>!mesh.metadata?.vegetation));
    point = null; settle();
    point = { x:0, y:10, z:0 }; settle();
    assert.deepEqual(counts(),steady);
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
  const {groupDistantSurfaces,groupStreetSurfaces,distantSurfaces}=await import('../src/modules/world/distant-surfaces.ts');
  const groups=groupDistantSurfaces(citySource);
  assert.ok(groups.length<=112);
  assert.ok(distantSurfaces.has('bank'));
  const banks=groups.filter(g=>g.surface==='bank');
  assert.ok(banks.length>0&&banks.length<=16);
  for(const surface of [...distantSurfaces].filter(surface=>surface!=='rail-track')){
    const source=citySource.chunks.flatMap(c=>c.meshes.filter(m=>m.surface===surface||(surface==='urban-ground'&&m.surface==='sidewalk')||(surface==='rail-ballast'&&m.surface==='rail-track'))),batches=groups.filter(g=>g.surface===surface);
    const vertices=batches.reduce((n,m)=>n+m.positions.length,0),indices=batches.reduce((n,m)=>n+m.indices.length,0);
    if(surface==='urban-ground'){
      const extraVertices=vertices-source.reduce((n,m)=>n+m.positions.length,0),extraIndices=indices-source.reduce((n,m)=>n+m.indices.length,0);
      assert.ok(extraIndices>0&&extraVertices>0&&extraVertices<extraIndices*3);
    }else{assert.equal(vertices,source.reduce((n,m)=>n+m.positions.length,0));assert.equal(indices,source.reduce((n,m)=>n+m.indices.length,0));}
    for(const batch of batches)assert.ok(batch.indices.every(i=>i>=0&&i<batch.positions.length/3));
  }
  const chunk=citySource.chunks[0];
  const triangle={surface:'water',positions:[0,0,0,1,0,0,0,0,1],indices:[0,1,2]};
  const paired=groupDistantSurfaces({...citySource,chunks:[{...chunk,meshes:[triangle,{...triangle,positions:triangle.positions.map((v,i)=>i%3===0?v+2:v)}]}]});
  assert.deepEqual(paired[0].indices,[0,1,2,3,4,5]);
  assert.ok(['road','sidewalk','curb','marking'].every(s=>!distantSurfaces.has(s)));
  assert.ok(groups.every(g=>!['road','sidewalk','rail-track'].includes(g.surface)));
  const street=groupDistantSurfaces({...citySource,chunks:[{...chunk,meshes:[{...triangle,surface:'road'},{...triangle,surface:'sidewalk',positions:triangle.positions.map((v,i)=>i%3===1?v+.25:v)}]}]});
  assert.equal(street.length,2);assert.deepEqual(new Set(street.map(m=>m.surface)),new Set(['road-base','urban-ground']));
  const base=groups.filter(g=>g.surface==='road-base');assert.ok(base.length>0);
  assert.equal(base.reduce((n,m)=>n+m.indices.length,0),citySource.chunks.flatMap(c=>c.meshes.filter(m=>m.surface==='road')).reduce((n,m)=>n+m.indices.length,0));
  const near=groupStreetSurfaces({...citySource,chunks:[{...chunk,meshes:[{...triangle,surface:'road'},{...triangle,surface:'sidewalk'},triangle]}]});
  assert.equal(near.length,1);assert.equal(near[0].surface,'sidewalk');assert.deepEqual(near[0].positions,triangle.positions);
  assert.ok(street.every(m=>m.positions.every((v,i)=>i%3!==1||Math.abs(v)<1e-9)));
  const curb=groupDistantSurfaces({...citySource,chunks:[{...chunk,meshes:[{surface:'curb',positions:[0,.25,0,1,.25,0,0,.25,1,0,0,0],indices:[0,1,2,0,3,1]}]}]});
  assert.equal(curb[0].indices.length,3);assert.ok(curb[0].positions.every((v,i)=>i%3!==1||v===0));
});

test('grass follows authored slopes, keeps stable roots and reduces geometry with distance', async t => {
  const { createGrass, groupGrass, sampleGrass } = await import('../src/modules/world/grass.ts');
  const positions = [-2, -2, 0, 2, 2, 0, -2, -2, 4];
  const patches = groupGrass({
    ...citySource,
    chunks: [{
      ...citySource.chunks[0],
      meshes: [
        { surface: 'terrain', positions, indices: [0, 1, 2] },
        { surface: 'road', positions: positions.map((v, i) => i % 3 === 0 ? v + 32 : v), indices: [0, 1, 2] },
      ],
    }],
  });
  assert.equal(patches.size, 2);
  const roots = [...patches.values()].flatMap(sampleGrass);
  assert.ok(roots.length > 100);
  assert.ok(roots.every(({x, y, z}) => x >= -2 && z >= 0 && x + z <= 2 && Math.abs(x - y) < 1e-9));
  assert.deepEqual(roots, [...patches.values()].flatMap(sampleGrass));

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const owner = createScope();
  t.after(() => { owner.dispose(); scene.dispose(); engine.dispose(); });
  const createPatch = createGrass(scene, owner);
  const active = () => scene.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.isEnabled());
  const updates = [...patches.values()].map((patch, index) => createPatch(`test/grass/${index}`, patch, owner, () => {}));
  const move = (x: number, y: number, indoors = false) => updates.forEach(update => update(new Vector3(x, y, 2), indoors));
  move(0, 3);
  const near = active();
  assert.equal(near.length, 2);
  assert.ok(near.every(mesh => mesh.getTotalIndices() === 9 && mesh.thinInstanceCount > 0));
  const nearCounts = near.map(mesh => mesh.thinInstanceCount);
  move(0, 3, true);
  assert.deepEqual(active().map(mesh => mesh.thinInstanceCount), nearCounts);
  for (const mesh of near) {
    const normals = mesh.getVerticesData('normal');
    assert.ok(normals && normals.filter((_, index) => index % 3 === 1).every(y => y > 0));
  }
  assert.notEqual(near[0].getVertexBuffer('world3'), near[1].getVertexBuffer('world3'));
  const colors = (mesh: Mesh) => mesh.getVertexBuffer('instanceColor')?.getFloatData(mesh.thinInstanceCount);
  const nearColors = colors(near[0]);
  assert.ok(nearColors && nearColors[1] > nearColors[0] && nearColors[0] > nearColors[2]);
  assert.ok(new Set(nearColors).size > 4);
  assert.ok(near[0].getBoundingInfo().boundingBox.centerWorld.x < 0);
  assert.ok(near[1].getBoundingInfo().boundingBox.centerWorld.x > 0);
  move(55, 3);
  const far = active();
  assert.equal(far.length, 2);
  assert.ok(far.every((mesh, index) => mesh.getTotalIndices() === 3 && mesh.thinInstanceCount < near[index].thinInstanceCount));
  const farColors = colors(far[0]);
  assert.ok(farColors && farColors.length > 0);
  assert.deepEqual(Array.from(farColors), Array.from(nearColors.slice(0, farColors.length)));
  for (const axis of ['world0', 'world1']) {
    const farAxis = far[0].getVertexBuffer(axis)?.getFloatData(far[0].thinInstanceCount);
    const nearAxis = near[0].getVertexBuffer(axis)?.getFloatData(near[0].thinInstanceCount);
    assert.ok(farAxis && nearAxis);
    assert.deepEqual(Array.from(farAxis), Array.from(nearAxis.slice(0, farAxis.length)));
  }
  move(55, 3, true);
  assert.equal(active().length, 0);
  move(55, 3);
  assert.deepEqual(active(), far);
  move(100, 3);
  assert.equal(active().length, 0);
  move(0, 3);
  assert.deepEqual(active(), near);
});

test('underwater view attaches when the near plane crosses water and detaches over dry ground', async t => {
  const { FreeCamera } = await import('@babylonjs/core/Cameras/freeCamera.js');
  const { createUnderwaterView } = await import('../src/modules/world/underwater.ts');
  const engine = new NullEngine(), scene = new Scene(engine), owner = createScope();
  t.after(() => { owner.dispose(); scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera('waterline-test', new Vector3(0, 1, 0), scene);
  camera.minZ = .1;
  createUnderwaterView(scene, {
    level: 0,
    triangles: [[-2,0,-2,2,0,-2,0,0,2]],
  }, owner);
  const frame = () => {
    camera.getViewMatrix();
    camera.getProjectionMatrix();
    scene.onBeforeCameraRenderObservable.notifyObservers(camera);
  };

  frame();
  assert.equal(engine.postProcesses.length, 0);
  camera.position.y = .02;
  frame();
  assert.equal(engine.postProcesses.length, 1);
  const post = engine.postProcesses[0];
  for(let i=0;!post.isReady()&&i<50;i++)await new Promise(resolve=>setTimeout(resolve,10));
  frame();
  assert.equal(camera._getFirstPostProcess(), post);
  camera.position.set(4,-1,0);
  frame();
  assert.equal(camera._getFirstPostProcess(), null);
  assert.equal(engine.postProcesses.length, 1);
  owner.dispose();
  assert.equal(engine.postProcesses.length, 0);
});
