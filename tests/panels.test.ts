import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPanels } from '../src/core/panels.ts';

test('panels register, toggle independently and notify until unsubscribed', () => {
  const panels = createPanels();
  let changes = 0;
  const unsubscribe = panels.subscribe(() => changes++);
  const removeA = panels.register('a', 'A', 'content A');
  const removeB = panels.register('b', 'B', 'content B');
  assert.equal(panels.getSnapshot(), panels.getSnapshot());
  assert.throws(() => panels.register('a', 'Duplicate', ''), /уже зарегистрирована/);
  panels.toggle('a');
  assert.deepEqual(panels.getSnapshot().map(panel => panel.open), [true, false]);
  panels.close('a');
  assert.equal(panels.getSnapshot()[0].open, false);
  removeA();
  assert.deepEqual(panels.getSnapshot().map(panel => panel.id), ['b']);
  assert.equal(changes, 5);
  unsubscribe();
  removeB();
  assert.deepEqual(panels.getSnapshot(), []);
  assert.equal(changes, 5);
  const removeNew = panels.register('a', 'A', 'new session');
  assert.equal(panels.getSnapshot()[0].open, false);
  removeNew();
});
