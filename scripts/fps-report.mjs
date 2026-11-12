import { styleText } from 'node:util';
import { fpsColor } from '../src/core/fps-color.ts';
import { summarizeTests } from '../src/core/test-summary.ts';

export function validateFpsConfig(value) {
  const grades = ['red', 'orange', 'yellow', 'green'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['metric', 'passGrades'].includes(key)) || value.metric !== 'average' ||
      !Array.isArray(value.passGrades) || !value.passGrades.length ||
      !value.passGrades.every(grade => grades.includes(grade)) || new Set(value.passGrades).size !== value.passGrades.length) {
    throw new Error('Invalid fps.config.json: expected metric "average" and non-empty unique passGrades from red, orange, yellow, green');
  }
  return { metric: value.metric, passGrades: [...value.passGrades] };
}

export function createFpsReport(run, config) {
  const summary = summarizeTests(run.results);
  const failures = [];
  if (!run.results.length) failures.push('No test scenarios ran');
  for (const result of run.results) {
    if (result.status !== 'completed') failures.push(`${result.id}: ${result.status}${result.error ? ` (${result.error})` : ''}`);
    if (!result.metrics || ![result.metrics.average, result.metrics.min, result.metrics.max, result.metrics.median, result.metrics.p95FrameMs, result.metrics.frames, result.metrics.seconds].every(value => Number.isFinite(value) && value > 0)) failures.push(`${result.id}: no valid FPS measurement`);
  }
  const grade = summary.average !== null && Number.isFinite(summary.average) ? fpsColor(summary.average) : null;
  if (!config.passGrades.includes(grade)) failures.push(`Average FPS ${summary.average?.toFixed(1) ?? 'unavailable'} has grade ${grade ?? 'unavailable'}; allowed: ${config.passGrades.join(', ')}`);
  return { version: 2, measuredAt: new Date().toISOString(), ...run, summary, policy: config, grade, passed: failures.length === 0, failures };

}

export function printFpsReport(report, path) {
  const colors = { red: 'red', orange: 'yellow', yellow: 'yellowBright', green: 'green' };
  const width = Math.max('Module'.length, 'Total'.length, ...report.results.map(result => result.id.length));
  const row = (label, value) => {
    const number = (value == null ? '—' : value.toFixed(1)).padStart(11);
    const cell = value == null ? number : styleText(colors[fpsColor(value)], number);
    return `│ ${label.padEnd(width)} │ ${cell} │`;
  };
  const border = (left, middle, right) => `${left}${'─'.repeat(width + 2)}${middle}${'─'.repeat(13)}${right}`;
  console.log('\nFPS benchmark');
  console.log(border('┌', '┬', '┐'));
  console.log(`│ ${'Module'.padEnd(width)} │ Average FPS │`);
  console.log(border('├', '┼', '┤'));
  for (const result of report.results) console.log(row(result.id, result.metrics?.average));
  console.log(border('├', '┼', '┤'));
  console.log(row('Total', report.summary.average));
  console.log(border('└', '┴', '┘'));
  console.log(`Result: ${styleText(report.passed ? 'green' : 'red', report.passed ? 'PASS' : 'FAIL')} · Allowed: ${report.policy.passGrades.join(', ')}`);
  console.log(`Renderer: ${report.environment.renderer}`);
  console.log(`Viewport: ${report.environment.width}×${report.environment.height}`);
  if (/swiftshader|llvmpipe|software/i.test(report.environment.renderer)) console.log('Software renderer: these results do not measure your physical GPU.');
  for (const failure of report.failures) console.error(failure);
  console.log(`JSON report: ${path}\n`);
}
