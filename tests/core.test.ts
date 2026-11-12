import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleFactory, resolveModules, startModules, type ModuleDefinition } from '../src/core/modules.ts';
import { readSelection, encodeSelection } from '../src/core/settings.ts';
import { createLocalAuthority } from '../src/simulation/authority.ts';
const define = moduleFactory<{}>();
test('dependencies order, APIs and reverse cleanup', () => {
  const log: string[] = [];
  const a = define({ id: 'a', category: 'Тесты', title: 'A', requires: {}, setup({ scope }) { log.push('a'); scope.onDispose(() => log.push('-a')); return { answer: 42 }; } });
  const b = define({ id: 'b', category: 'Тесты', title: 'B', requires: { a }, setup({ deps, scope }) { assert.equal(deps.a.answer, 42); log.push('b'); scope.onDispose(() => log.push('-b')); return {}; } });
  const running = startModules([b, a], ['b'], {});
  assert.deepEqual(running.ids, ['a', 'b']);
  running.dispose(); running.dispose();
  assert.deepEqual(log, ['a', 'b', '-b', '-a']);
});
test('missing dependencies, duplicate IDs and cycles fail before setup', () => {
  const a: ModuleDefinition<{}> = { id: 'a', category: 'Тесты', title: 'A', requires: {}, setup() { throw new Error('must not run'); } };
  const b: ModuleDefinition<{}> = { id: 'b', category: 'Тесты', title: 'B', requires: { a }, setup() {} };
  assert.throws(() => resolveModules([b], ['b']), /Незарегистрированная/);
  assert.throws(() => resolveModules([a, a], []), /Повторяющийся/);
  Object.assign(a, { requires: { b } });
  assert.throws(() => resolveModules([a, b], ['a']), /Циклическая/);
  assert.throws(() => resolveModules([], ['missing']), /Неизвестный/);
});
test('failed setup cleans partial resources and continues after cleanup errors', () => {
  const log: number[] = [];
  const broken = define({ id: 'broken', category: 'Тесты', title: '', requires: {}, setup({ scope }) {
    scope.onDispose(() => log.push(1)); scope.onDispose(() => { throw new Error('cleanup'); }); scope.onDispose(() => log.push(2));
    throw new Error('setup');
  } });
  assert.throws(() => startModules([broken], ['broken'], {}), AggregateError);
  assert.deepEqual(log, [2, 1]);
});
test('settings validate data, migrate unknown IDs and add mandatory dependencies', () => {
  const a = define({ id: 'a', category: 'Тесты', title: '', required: true, requires: {}, setup() { return {}; } });
  const b = define({ id: 'b', category: 'Тесты', title: '', requires: { a }, setup() { return {}; } });
  for (const raw of ['invalid', 'null', '{"version":2,"enabled":[]}', '{"version":1,"enabled":[42]}']) assert.deepEqual(readSelection(raw, [a, b], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(readSelection(encodeSelection(['removed', 'b']), [a, b], []), ['a', 'b']);
  assert.deepEqual(readSelection(encodeSelection([]), [a, b], []), ['a']);
});
test('simulation time agrees at 15, 30, 60 and 144 FPS', () => {
  for (const fps of [15, 30, 60, 144]) {
    const authority = createLocalAuthority();
    for (let frame = 0; frame < fps * 10; frame++) authority.advance(1000 / fps);
    assert.equal(authority.snapshot().tick, 600);
    assert.equal(authority.snapshot().seconds, 10);
  }
});
test('long stalls retain time debt and eventually catch up', () => {
  const authority = createLocalAuthority();
  authority.advance(60_000);
  assert.equal(authority.snapshot().tick, 240);
  assert.equal(authority.snapshot().pendingTicks, 3360);
  for (let i = 0; i < 14; i++) authority.advance(0);
  assert.equal(authority.snapshot().tick, 3600);
  assert.equal(authority.snapshot().pendingTicks, 0);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => authority.advance(value));
});
