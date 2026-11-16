import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { defaultPixelShader } from '@babylonjs/core/Shaders/default.fragment.js';
import { defaultVertexShader } from '@babylonjs/core/Shaders/default.vertex.js';
import { SurfaceScale } from '../src/modules/materials/surface-scale.ts';
import { bumpFragment } from '@babylonjs/core/Shaders/ShadersInclude/bumpFragment.js';
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js';
import { defineModule } from '../src/core/context.ts';
import { createPanels } from '../src/core/panels.ts';
import { startModules } from '../src/core/modules.ts';
import { geometryModule } from '../src/modules/geometry/index.ts';
import { objectTemplatesModule } from '../src/modules/object-templates/index.ts';
import { objectRenderingModule } from '../src/modules/object-rendering/index.ts';
import { createMaterials } from '../src/modules/materials/resources.ts';

function ownerScope() {
  const cleanups: (() => void)[] = [];
  return { onDispose: (cleanup: () => void) => { cleanups.push(cleanup); }, dispose: () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); } };
}

test('materials share loaded textures, follow LOD and restore existing regular and batched objects on disposal', async t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const camera = new FreeCamera('camera', Vector3.Zero(), scene);
  const consumer = defineModule({ id: 'materials-probe', title: '', category: 'Тесты', requires: { geometry: geometryModule, templates: objectTemplatesModule, rendering: objectRenderingModule }, setup({ deps }) { return deps; } });
  let deps: ReturnType<typeof consumer.setup> | undefined;
  const capture = defineModule({ id: 'capture', title: '', category: 'Тесты', requires: { probe: consumer }, setup({ deps: values }) { deps = values.probe; return {}; } });
  const session = startModules([geometryModule, objectTemplatesModule, objectRenderingModule, consumer, capture], ['capture'], { scene, panels: createPanels(), onFrame: new Observable<number>() });
  t.after(() => session.dispose());
  assert.ok(deps);
  const { geometry, templates, rendering } = deps;
  const owner = ownerScope();
  t.after(owner.dispose);
  templates.register({ id: 'styled-box', version: 1, parameters: {}, build: () => ({ hideDistance: 80, levels: [0, 10, 25].map(distance => ({ distance, parts: [{ surface: 'walls', size: [2, 2, 2] }] })) }) }, owner);
  const plain = rendering.createObject('styled-box', 'regular', {}, owner, 'static');
  const batched = rendering.createObject('styled-box', 'batched', {}, owner, 'static', 'walls');
  const frame = () => scene.onBeforeRenderObservable.notifyObservers(scene);
  frame();
  const fallback = geometry.getSurfaceMaterial('walls');
  assert.equal(plain.root.getChildMeshes()[0].material, fallback);
  for (let repeat = 0; repeat < 2; repeat++) {
    camera.position.x = 0; frame();
    const materialOwner = ownerScope();
    t.after(materialOwner.dispose);
    const api = createMaterials(scene, geometry, materialOwner);
    assert.equal(api.getSnapshot().materials, 22);
    assert.equal(api.getSnapshot().textures, 12);
    assert.ok(api.getSnapshot().estimatedBytes < 17 * 1024 * 1024);
    assert.equal(plain.root.getChildMeshes()[0].material, geometry.getSurfaceMaterial('walls'));
    assert.throws(() => geometry.registerSurfaceMaterials(new Map(), owner), /подключено/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(api.getSnapshot().loading, 0);
    assert.equal(api.getSnapshot().failed, 0);
    for(const material of scene.materials)if(material instanceof StandardMaterial&&material.name.startsWith('materials/')&&material.emissiveColor.r===0&&material.emissiveColor.g===0&&material.emissiveColor.b===0){
      assert.ok(material.diffuseTexture,`Missing texture: ${material.name}`);
      assert.ok(material.bumpTexture,`Missing normal map: ${material.name}`);
    }
    const curb=geometry.getSurfaceMaterial('curb'),walk=geometry.getSurfaceMaterial('sidewalk');
    assert.ok(curb instanceof StandardMaterial&&walk instanceof StandardMaterial);assert.ok(curb.diffuseColor.r>walk.diffuseColor.r+.15);
    const marking=geometry.getSurfaceMaterial('marking');assert.ok(marking instanceof StandardMaterial);
    assert.equal(marking.zOffset,-1);assert.equal(marking.zOffsetUnits,-2);assert.equal(marking.disableDepthWrite,false);
    const city=geometry.getSurfaceMaterial('city-stone');
    assert.ok(city instanceof StandardMaterial);assert.ok(city.getActiveTextures().some(t=>t.name.endsWith('roof-512.webp')));assert.ok(city.getActiveTextures().some(t=>t.name.endsWith('roof-normal.webp')));
    const shell = geometry.getSurfaceMaterial('building-shell');
    assert.ok(shell instanceof StandardMaterial);
    assert.ok(shell.pluginManager?.getPlugin('SurfaceScale'));
    assert.equal(shell.getActiveTextures().length, 8);
    assert.ok(shell.getActiveTextures().every(texture => shell.hasTexture(texture)));
    const sidewalk = geometry.getSurfaceMaterial('sidewalk');
    const foundation = geometry.getSurfaceMaterial('foundation');
    assert.ok(sidewalk instanceof StandardMaterial && foundation instanceof StandardMaterial);
    assert.equal(sidewalk.diffuseTexture, foundation.diffuseTexture);
    const door=geometry.getSurfaceMaterial('facade'),metal=geometry.getSurfaceMaterial('metal');
    assert.ok(door instanceof StandardMaterial&&metal instanceof StandardMaterial);
    assert.equal(door.diffuseTexture,metal.diffuseTexture);
    assert.notDeepEqual(door.diffuseColor.asArray(),metal.diffuseColor.asArray());
    assert.equal(sidewalk.bumpTexture, foundation.bumpTexture);
    assert.ok(sidewalk.bumpTexture instanceof Texture);
    assert.equal(sidewalk.bumpTexture.gammaSpace, false);
    assert.equal(sidewalk.diffuseTexture?.gammaSpace, true);
    assert.equal(sidewalk.bumpTexture.noMipmap, false);
    assert.ok(sidewalk.bumpTexture.name.endsWith('concrete-normal.webp'));
    assert.ok(sidewalk.diffuseTexture instanceof Texture);
    assert.equal(sidewalk.diffuseTexture.noMipmap, false);
    assert.equal(sidewalk.diffuseTexture.samplingMode, Texture.TRILINEAR_SAMPLINGMODE);
    for (const [x, level, size] of [[0, 0, 512], [20, 1, 512], [40, 2, 512]] as const) {
      camera.position.x = x; frame();
      assert.equal(plain.level(), level);
      assert.equal(batched.level(), level);
      const material = geometry.getSurfaceMaterial('walls', level);
      assert.ok(material instanceof StandardMaterial);
      assert.ok(plain.root.getChildMeshes().some(mesh => mesh.isEnabled() && mesh.material === material));
      assert.ok(scene.meshes.some(mesh => mesh.name.startsWith('surface-batch/') && mesh.material === material));
      assert.ok(material.diffuseTexture?.name.endsWith(`brick-${size}.webp`));
    }
    for (const surface of ['building-shell', 'terrain', 'road', 'sidewalk', 'curb', 'walls', 'roof', 'foundation', 'facade', 'metal']) {
      const middle = geometry.getSurfaceMaterial(surface, 1);
      const far = geometry.getSurfaceMaterial(surface, 2);
      assert.ok(middle instanceof StandardMaterial && far instanceof StandardMaterial);
      assert.ok(far.diffuseTexture);
      assert.equal(far, middle);
      assert.equal(far, geometry.getSurfaceMaterial(surface, 0));
    }
    const lamp = geometry.getSurfaceMaterial('lamp-head', 2);
    assert.ok(lamp instanceof StandardMaterial);
    assert.equal(lamp.diffuseTexture, null);
    assert.equal(api.getSnapshot().textures, 12);
    materialOwner.dispose(); frame();
    assert.equal(geometry.getSurfaceMaterial('walls'), fallback);
    assert.ok(plain.root.getChildMeshes().every(mesh => mesh.material === fallback));
    assert.ok(scene.meshes.filter(mesh => mesh.name.startsWith('surface-batch/')).every(mesh => mesh.material === fallback));
    assert.equal(scene.textures.length, 0);
    assert.equal(scene.materials.length, 1);
    assert.equal(rendering.getStats().objects, 2);
  }
  const pending = ownerScope();
  createMaterials(scene, geometry, pending);
  pending.dispose();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(scene.textures.length, 0);
  assert.equal(scene.materials.length, 1);
});


test('surface scale hooks match installed Babylon shaders without adding an extra base sample', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  const material = new StandardMaterial('hook-contract', scene);
  const plugin = new SurfaceScale(material, true, () => undefined);
  const fragment = plugin.getCustomCode('fragment');
  const vertex = plugin.getCustomCode('vertex');
  assert.ok(fragment && vertex);
  const replacement = Object.keys(fragment).find(key => key.startsWith('!'));
  assert.ok(replacement);
  assert.equal([...defaultPixelShader.shader.matchAll(new RegExp(replacement.slice(1), 'g'))].length, 1);
  for (const key of Object.keys(fragment).filter(key => key.startsWith('!') && key !== replacement)) {
    assert.equal([...bumpFragment.shader.matchAll(new RegExp(key.slice(1), 'g'))].length, key.includes('TEXRD') ? 2 : 1, key);
  }
  assert.ok(fragment.CUSTOM_FRAGMENT_DEFINITIONS.includes('surfaceNormalsReady.z < 0.5'));
  assert.ok(fragment.CUSTOM_FRAGMENT_DEFINITIONS.includes('return vec4(0.5, 0.5, 1.0, 1.0)'));
  for (const point of Object.keys(vertex)) assert.ok(defaultVertexShader.shader.includes(`#define ${point}`));
  assert.equal(plugin.getCustomCode('compute'), null);
});
