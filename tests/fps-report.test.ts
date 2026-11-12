import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node executes the CLI helper directly; no declaration wrapper needed.
import { createFpsReport, validateFpsConfig, printFpsReport } from '../scripts/fps-report.mjs';
import { frameMetrics } from '../src/core/test-runner.ts';

const config = { metric: 'average', passGrades: ['yellow', 'green'] };

test('FPS report uses the configured grades of aggregate average FPS', () => {
  for (const [fps, grade, passed] of [[29, 'red', false], [30, 'orange', false], [59.99, 'orange', false], [60, 'yellow', true], [89.99, 'yellow', true], [90, 'green', true], [144, 'green', true]] as const) {
    const run = { results: [{ id: 'a', status: 'completed', metrics: { ...frameMetrics([10]), frames: fps * 100, seconds: 100, average: fps } }] };
    const report = createFpsReport(run, config);
    assert.equal(report.grade, grade);
    assert.equal(report.passed, passed);
    assert.deepEqual(report.policy, config);
  }
  const run = { results: [
    { id: 'a', status: 'completed', metrics: frameMetrics([10, 10]) },
    { id: 'b', status: 'completed', metrics: frameMetrics([40]) },
  ] };
  assert.equal(createFpsReport(run, config).summary.average, 50);
  assert.equal(createFpsReport(run, config).passed, false);
  assert.equal(createFpsReport(run, { metric: 'average', passGrades: ['orange'] }).passed, true);
});

test('errors and missing measurements fail regardless of allowed grades', () => {
  assert.equal(createFpsReport({ results: [] }, config).passed, false);
  for (const status of ['cancelled', 'failed', 'completed']) {
    assert.equal(createFpsReport({ results: [{ id: 'a', status, metrics: null }] }, config).passed, false);
  }
  assert.equal(createFpsReport({ results: [{ id: 'a', status: 'completed', metrics: { ...frameMetrics([10]), seconds: Infinity } }] }, config).passed, false);
});

test('FPS config rejects unsupported metrics, grades, duplicates and typos', () => {
  assert.deepEqual(validateFpsConfig(config), config);
  for (const value of [null, [], {}, { ...config, metric: 'min' }, { ...config, passGrades: [] }, { ...config, passGrades: ['blue'] }, { ...config, passGrades: ['green', 'green'] }, { ...config, typo: true }]) {
    assert.throws(() => validateFpsConfig(value));
  }
});

test('CLI output only shows average FPS and preserves failures', t => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const report = createFpsReport({
    results: [{ id: 'beacon', status: 'failed', error: 'scenario error', metrics: frameMetrics([20]) }],
    environment: { width: 1280, height: 720, renderer: 'SwiftShader' },
  }, config);
  printFpsReport(report, 'report.json');
  const output = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(output, /Result: FAIL/);
  assert.match(output, /│ beacon │        50.0 │/);
  assert.match(output, /│ Total  │        50.0 │/);
  const table = output.split('\n').filter(line => /^[│┌├└]/.test(line));
  assert.ok(table.length > 0);
  assert.ok(table.every(line => line.length === table[0].length));
  assert.match(output, /scenario error/);
  assert.match(output, /Software renderer/);
  assert.match(output, /report.json/);
  assert.doesNotMatch(output, /min FPS|max FPS|median|P95|frames/);
});
