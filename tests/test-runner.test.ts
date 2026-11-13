import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestRunner, frameMetrics } from '../src/core/test-runner.ts';
import { moduleFactory, startModules, type RunnableTest } from '../src/core/modules.ts';

function fixture() {
  const events: string[] = [];
  const runner = createTestRunner(() => {}, () => { events.push('lock'); return () => { events.push('unlock'); }; });
  const scenario: RunnableTest = { id: 'a', title: 'A', durationSeconds: 2, setup(scope) {
    events.push('setup');
    scope.onDispose(() => { events.push('cleanup'); });
    return progress => { assert.ok(progress >= 0 && progress <= 1); };
  } };
  return { runner, scenario, events };
}

test('FPS uses total elapsed time; median and P95 use actual frame intervals', () => {
  assert.equal(frameMetrics([]), null);
  const metrics = frameMetrics([10, 20, 30, 40])!;
  assert.equal(metrics.average, 40);
  assert.equal(metrics.min, 25);
  assert.equal(metrics.max, 100);
  assert.equal(metrics.median, 40);
  assert.equal(metrics.p95FrameMs, 40);
  assert.equal(frameMetrics([10, 20, 30])!.median, 50);
});

test('scenario diagnostics are copied, collected on cleanup and reset between scenarios', async () => {
  const { runner, scenario } = fixture();
  const values = { hidden: 75 };
  const done = runner.run([{ ...scenario, setup(scope, report) {
    scope.onDispose(() => { report?.(values); values.hidden = 0; });
    return () => {};
  } }, { ...scenario, id: 'b' }]);
  for (let i = 0; i < 2; i++) { runner.advance(1); runner.advance(1000); runner.advance(2000); }
  const results = await done;
  assert.deepEqual(results[0].diagnostics, { hidden: 75 });
  assert.equal(results[1].diagnostics, undefined);
  const invalid = await runner.run([{ ...scenario, setup(_scope, report) { report?.({ hidden: NaN }); return () => {}; } }]);
  assert.equal(invalid[0].status, 'failed');
  assert.match(invalid[0].error ?? '', /конечные числа/);
});

test('runs sequentially with warmup excluded, cleanup and controls restored', async () => {
  const { runner, scenario, events } = fixture();
  const done = runner.run([scenario, { ...scenario, id: 'b' }]);
  await assert.rejects(runner.run([scenario]), /уже запущен/);
  for (let i = 0; i < 2; i++) {
    runner.advance(5000); // setup frame is excluded
    runner.advance(1000); // warmup is excluded
    runner.advance(500); runner.advance(500); runner.advance(1000);
  }
  const results = await done;
  assert.deepEqual(results.map(result => result.status), ['completed', 'completed']);
  assert.equal(results[0].metrics?.frames, 3);
  assert.equal(results[0].metrics?.seconds, 2);
  assert.deepEqual(events, ['lock', 'setup', 'cleanup', 'setup', 'cleanup', 'unlock']);
  assert.equal(runner.getState().running, false);
  assert.equal(runner.getState().progress, 1);
});

test('stop retains partial metrics and does not run queued tests', async () => {
  const { runner, scenario, events } = fixture();
  const done = runner.run([scenario, { ...scenario, id: 'b' }]);
  runner.advance(10); runner.advance(1000); runner.advance(100);
  runner.stop(); runner.stop();
  const results = await done;
  assert.equal(results[0].status, 'cancelled');
  assert.equal(results[0].metrics?.frames, 1);
  assert.equal(results.length, 1);
  assert.deepEqual(events, ['lock', 'setup', 'cleanup', 'unlock']);
});

test('setup, frame and cleanup failures always release controls', async () => {
  for (const failure of ['setup', 'frame', 'cleanup']) {
    const { runner, scenario, events } = fixture();
    const done = runner.run([{ ...scenario, setup(scope) {
      scope.onDispose(() => { events.push('cleanup'); if (failure === 'cleanup') throw new Error('cleanup'); });
      if (failure === 'setup') throw new Error('setup');
      return progress => { if (failure === 'frame' && progress > 0) throw new Error('frame'); };
    } }]);
    runner.advance(10); runner.advance(1000); runner.advance(2000);
    const results = await done;
    assert.equal(results[0].status, 'failed');
    assert.match(results[0].error!, new RegExp(failure));
    assert.deepEqual(events, ['lock', 'cleanup', 'unlock']);
    assert.equal(runner.getState().running, false);
  }
});

test('invalid runs are rejected without locking; duration override is respected', async () => {
  const { runner, scenario, events } = fixture();
  await assert.rejects(runner.run([]));
  for (const duration of [0, -1, NaN, Infinity, 301]) await assert.rejects(runner.run([scenario], duration));
  assert.deepEqual(events, []);
  const done = runner.run([scenario], 1);
  runner.advance(10); runner.advance(1000); runner.advance(1000);
  assert.equal((await done)[0].status, 'completed');
});

test('module scenarios receive their own API, declared deps and independent cleanup scope', () => {
  const define = moduleFactory<{}>();
  const dep = define({ id: 'dep', title: '', category: '', requires: {}, setup() { return { value: 2 }; } });
  let cleaned = false;
  const module = define({ id: 'test', title: '', category: '', requires: { dep }, setup() { return { value: 3 }; },
    test: { durationSeconds: 1, setup({ api, deps, scope, report }) {
      assert.equal(api.value + deps.dep.value, 5);
      report({ combined: api.value + deps.dep.value });
      scope.onDispose(() => { cleaned = true; });
      return () => {};
    } },
  });
  const running = startModules([dep, module], ['test'], {});
  let cleanup = () => {};
  let reported: Readonly<Record<string, number>> | undefined;
  running.tests[0].setup({ onDispose: dispose => { cleanup = dispose; } }, values => { reported = values; });
  assert.deepEqual(reported, { combined: 5 });
  cleanup(); assert.equal(cleaned, true);
  running.dispose();
});

test('lock failure and rendering failure settle the promise with a failed result', async () => {
  const { scenario } = fixture();
  const failedLock = createTestRunner(() => {}, () => { throw new Error('lock'); });
  const result = await failedLock.run([scenario]);
  assert.equal(result[0].status, 'failed');
  assert.match(result[0].error!, /lock/);
  const { runner, events, scenario: runningScenario } = fixture();
  const done = runner.run([runningScenario]);
  runner.fail(new Error('render'));
  assert.match((await done)[0].error!, /render/);
  assert.deepEqual(events, ['lock', 'setup', 'cleanup', 'unlock']);
});
