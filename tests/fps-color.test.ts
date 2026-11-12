import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fpsColor } from '../src/core/fps-color.ts';

test('FPS grades handle fractional boundaries and values above 120', () => {
  for (const [value, color] of [[0, 'red'], [29.99, 'red'], [30, 'orange'], [59.99, 'orange'], [60, 'yellow'], [89.99, 'yellow'], [90, 'green'], [120, 'green'], [240, 'green']] as const) {
    assert.equal(fpsColor(value), color);
  }
});
