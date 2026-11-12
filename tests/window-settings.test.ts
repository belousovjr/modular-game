import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWindow, writeWindow } from '../src/core/window-settings.ts';
import { createPanels } from '../src/core/panels.ts';

test('window visibility and position survive registration and storage errors', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  } });
  try {
    assert.deepEqual(readWindow('modules'), { open: false, position: { left: 16, top: 48 } });
    writeWindow('modules', { open: true });
    writeWindow('modules', { position: { left: 120, top: 80 } });
    assert.deepEqual(readWindow('modules'), { open: true, position: { left: 120, top: 80 } });
    const panels = createPanels();
    const remove = panels.register('clock', 'Clock', 'time');
    panels.toggle('clock');
    writeWindow('details-clock', { position: { left: 40, top: 90 } });
    remove();
    panels.register('clock', 'Clock', 'new time');
    assert.equal(panels.getSnapshot()[0].open, true);
    assert.deepEqual(readWindow('details-clock').position, { left: 40, top: 90 });
    panels.close('clock');
    assert.equal(readWindow('details-clock').open, false);
    assert.equal(readWindow('modules').open, true);
    for (const invalid of ['{', '{"version":2,"open":true}', '{"version":1,"open":"yes","position":{"left":-1,"top":4}}', '{"version":1,"position":{"left":1e999,"top":4}}']) {
      values.set('modular-game.window.bad', invalid);
      assert.deepEqual(readWindow('bad'), { open: false, position: { left: 16, top: 48 } });
    }
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Denied'); } });
    assert.doesNotThrow(() => writeWindow('modules', { open: false }));
    assert.equal(readWindow('modules').open, false);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
