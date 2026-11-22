import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FALL_ACCELERATION } from '../src/modules/characters/headless.ts';
import { createOnlineJumpHeight } from '../src/modules/characters/height-presentation.ts';

const ground = { tick: 0, grounded: true, verticalSpeed: 0, mode: 'walk', y: 0 } as const;

test('the online jump keeps moving on frames between server snapshots and settles on landing', () => {
  const sample = createOnlineJumpHeight();
  sample(ground, 0, 0, true);
  let previous = 0;
  for (let frame = 1; frame <= 38; frame++) {
    const tick = 1 + Math.floor((frame - 1) / 3) * 3;
    const t = tick / 60;
    const y = t * (5.5 - FALL_ACCELERATION * t / 2);
    const height = sample({ ...ground, tick, y, grounded: false, verticalSpeed: 5.5-FALL_ACCELERATION*t }, y, 1000/60, false);
    assert.ok(Math.abs(height - previous) < .14);
    if (frame < 17) assert.ok(height > previous);
    if (frame > 25) assert.ok(height < previous);
    previous = height;
  }
  const landed = { ...ground, tick: 42 };
  const first = sample(landed, 0, 1000/60, false);
  assert.ok(first > 0 && first < previous);
  for (let frame = 0; frame < 22; frame++) previous = sample(landed, 0, 1000/60, false);
  assert.equal(previous, 0);
});

test('vehicle and reconnect resets use the supplied height directly', () => {
  const sample = createOnlineJumpHeight();
  sample(ground, 0, 0, true);
  sample({ ...ground, tick: 4, grounded: false, y: .3, verticalSpeed: 5 }, .3, 16, false);
  assert.equal(sample({ ...ground, tick: 5, y: 1 }, 1, 16, true), 1);
});
