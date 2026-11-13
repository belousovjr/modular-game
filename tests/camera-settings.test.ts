import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_STORAGE_KEY, readCamera, writeCamera } from '../src/core/camera-settings.ts';

test('camera settings restore valid views and tolerate corrupt or unavailable storage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    assert.equal(readCamera(), undefined);
    const view = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0.4, y: -2, z: 0 } };
    writeCamera(view);
    assert.deepEqual(readCamera(), view);
    const distantView = { ...view, position: { x: 25000, y: 500, z: -15000 } };
    writeCamera(distantView);
    assert.deepEqual(readCamera(), distantView);
    for (const patch of [{ version: 3 }, { position: null }, { position: { x: '1', y: 2, z: 3 } }, { rotation: { x: 0, y: 1 } }, { rotation: { x: Math.PI / 2, y: 0, z: 0 } }]) {
      values.set(CAMERA_STORAGE_KEY, JSON.stringify({ version: 2, ...view, ...patch }));
      assert.equal(readCamera(), undefined);
    }
    values.set(CAMERA_STORAGE_KEY, JSON.stringify({ version: 1, alpha: -Math.PI / 2, beta: Math.PI / 2, radius: 12, target: { x: 1, y: 2, z: 3 } }));
    const migrated = readCamera();
    assert.ok(migrated);
    assert.ok(Math.abs(migrated.position.x - 1) < 1e-9);
    assert.ok(Math.abs(migrated.position.y - 2) < 1e-9);
    assert.ok(Math.abs(migrated.position.z + 9) < 1e-9);
    assert.deepEqual(migrated.rotation, { x: 0, y: 0, z: 0 });
    assert.equal(JSON.parse(values.get(CAMERA_STORAGE_KEY) ?? '{}').version, 2);
    for (const alpha of [-Math.PI / 2, 0, Math.PI / 2, 2.1]) {
      const target = { x: 10, y: 3, z: -7 };
      values.set(CAMERA_STORAGE_KEY, JSON.stringify({ version: 1, alpha, beta: 0.7, radius: 15000, target }));
      const converted = readCamera();
      assert.ok(converted);
      const { position, rotation } = converted;
      const length = Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z);
      const forward = { x: Math.sin(rotation.y) * Math.cos(rotation.x), y: -Math.sin(rotation.x), z: Math.cos(rotation.y) * Math.cos(rotation.x) };
      const dot = (forward.x * (target.x - position.x) + forward.y * (target.y - position.y) + forward.z * (target.z - position.z)) / length;
      assert.ok(dot > 1 - 1e-12);
    }
    for (const patch of [{ beta: 0 }, { radius: 15001 }, { target: null }]) {
      values.set(CAMERA_STORAGE_KEY, JSON.stringify({ version: 1, alpha: 0, beta: 1, radius: 12, target: { x: 0, y: 0, z: 0 }, ...patch }));
      assert.equal(readCamera(), undefined);
    }
    for (const raw of ['{', 'null', '{"version":1,"alpha":1e999}']) {
      values.set(CAMERA_STORAGE_KEY, raw);
      assert.equal(readCamera(), undefined);
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Denied'); } });
    assert.equal(readCamera(), undefined);
    assert.doesNotThrow(() => writeCamera(view));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
