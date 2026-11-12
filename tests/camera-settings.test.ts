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
    const view = { alpha: -2, beta: 1, radius: 12, target: { x: 1, y: 2, z: 3 } };
    writeCamera(view);
    assert.deepEqual(readCamera(), view);
    for (const patch of [{ version: 2 }, { alpha: '2' }, { beta: 0 }, { beta: Math.PI }, { radius: 2 }, { radius: 36 }, { target: { x: 1, y: 2 } }, { target: { x: '1', y: 2, z: 3 } }]) {
      values.set(CAMERA_STORAGE_KEY, JSON.stringify({ version: 1, ...view, ...patch }));
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
