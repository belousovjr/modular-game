import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTests } from '../src/core/test-summary.ts';
import { frameMetrics } from '../src/core/test-runner.ts';

test('summary weights FPS by measured time and includes partial runs and errors', () => {
  const summary = summarizeTests([
    { id: 'a', title: 'A', status: 'completed', metrics: frameMetrics([10, 10]) },
    { id: 'b', title: 'B', status: 'cancelled', metrics: frameMetrics([40]) },
    { id: 'c', title: 'C', status: 'failed', metrics: null, error: 'setup' },
  ]);
  assert.deepEqual(summary, { completed: 1, cancelled: 1, failed: 1, frames: 3, seconds: 0.06, average: 50, min: 25, max: 100 });
  assert.deepEqual(summarizeTests([]), { completed: 0, cancelled: 0, failed: 0, frames: 0, seconds: 0, average: null, min: null, max: null });
});
