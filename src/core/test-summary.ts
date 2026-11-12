import type { TestResult } from './test-runner.ts';

export function summarizeTests(results: readonly TestResult[]) {
  const measured = results.flatMap(result => result.metrics ? [result.metrics] : []);
  const frames = measured.reduce((sum, metrics) => sum + metrics.frames, 0);
  const seconds = measured.reduce((sum, metrics) => sum + metrics.seconds, 0);
  return {
    completed: results.filter(result => result.status === 'completed').length,
    cancelled: results.filter(result => result.status === 'cancelled').length,
    failed: results.filter(result => result.status === 'failed').length,
    frames, seconds,
    average: seconds > 0 ? frames / seconds : null,
    min: measured.length ? Math.min(...measured.map(metrics => metrics.min)) : null,
    max: measured.length ? Math.max(...measured.map(metrics => metrics.max)) : null,
  };
}
