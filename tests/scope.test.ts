import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScope } from '../src/core/scope.ts';

test('resource scope clears callbacks once in reverse order, including after a cleanup error', () => {
  const scope = createScope();
  const calls: number[] = [];
  scope.onDispose(() => calls.push(1));
  scope.onDispose(() => { calls.push(2); throw new Error('cleanup'); });
  scope.onDispose(() => calls.push(3));
  assert.throws(() => scope.dispose(), AggregateError);
  scope.dispose();
  scope.onDispose(() => calls.push(4));
  assert.deepEqual(calls, [3, 2, 1, 4]);
});
