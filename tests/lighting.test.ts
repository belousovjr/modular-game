import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { createLighting } from '../src/modules/lighting/light.ts';

test('lighting applies validated settings atomically and releases both lights on repeated setup', t => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  for (let repeat = 0; repeat < 2; repeat++) {
    const cleanups: (() => void)[] = [];
    const api = createLighting(scene, { onDispose: cleanup => cleanups.push(cleanup) });
    assert.equal(scene.lights.length, 2);
    const sun = scene.lights.find(light => light instanceof DirectionalLight);
    const ambient = scene.lights.find(light => light instanceof HemisphericLight);
    assert.ok(sun && ambient);
    assert.equal(sun.getShadowGenerator(), null);
    const defaults = api.getSettings();
    assert.ok(Object.isFrozen(defaults));
    let updates = 0;
    const unsubscribe = api.subscribe(() => updates++);
    api.setSettings({ hour: 12 });
    assert.ok(Math.abs(sun.direction.length() - 1) < 1e-6);
    assert.ok(sun.direction.y < -0.7);
    const noonIntensity = sun.intensity;
    const noonAmbient = ambient.intensity;
    api.setSettings({ hour: 7 });
    const morningX = sun.direction.x;
    assert.ok(sun.diffuse.b < sun.diffuse.r * 0.8);
    assert.ok(sun.intensity < noonIntensity);
    api.setSettings({ hour: 17 });
    assert.ok(morningX * sun.direction.x < 0);
    api.setSettings({ hour: 0 });
    assert.equal(sun.intensity, 0);
    assert.ok(ambient.intensity > 0 && ambient.intensity < noonAmbient / 5);
    assert.ok(ambient.diffuse.b > ambient.diffuse.r);
    const midnight = sun.direction.clone();
    api.setSettings({ hour: 23.999 });
    assert.ok(sun.direction.subtract(midnight).length() < 0.001);
    const before = api.getSettings();
    const updateCount = updates;
    for (const hour of [NaN, Infinity, -1, 24, 100]) {
      assert.throws(() => api.setSettings({ hour }), /Время суток/);
      assert.equal(api.getSettings(), before);
      assert.equal(sun.intensity, 0);
      assert.equal(updates, updateCount);
    }
    unsubscribe();
    api.setSettings(defaults);
    assert.equal(updates, updateCount);
    for (const cleanup of cleanups.reverse()) cleanup();
    assert.equal(scene.lights.length, 0);
    assert.throws(() => api.setSettings(defaults), /остановлено/);
    assert.throws(() => api.subscribe(() => {}), /остановлено/);
  }
});
