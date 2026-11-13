import type { RunnableTest, TestDiagnostics } from './modules.ts';

function errorMessage(error: unknown): string {
  return error instanceof AggregateError ? `${error.message}: ${error.errors.map(errorMessage).join('; ')}` : String(error);
}

export function frameMetrics(samples: readonly number[]) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    frames: samples.length,
    seconds: samples.reduce((sum, ms) => sum + ms, 0) / 1000,
    average: samples.length * 1000 / samples.reduce((sum, ms) => sum + ms, 0),
    min: 1000 / sorted[sorted.length - 1], max: 1000 / sorted[0], median: 1000 / median,
    p95FrameMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
export interface TestResult {
  id: string; title: string; status: 'completed' | 'cancelled' | 'failed';
  metrics: ReturnType<typeof frameMetrics>; error?: string;
  diagnostics?: TestDiagnostics;
}
export interface TestState {
  running: boolean; title: string; progress: number; index: number; total: number;
  results: readonly TestResult[];
}
export function createTestRunner(changed: (state: TestState) => void, lock: () => () => void) {
  let state: TestState = { running: false, title: '', progress: 0, index: 0, total: 0, results: [] };
  let queue: readonly RunnableTest[] = [];
  let elapsed = 0;
  let samples: number[] = [];
  let diagnostics: TestDiagnostics = {};
  let update: ((progress: number) => void) | undefined;
  let cleanups: (() => void)[] = [];
  let unlock: (() => void) | undefined;
  let resolve: ((results: readonly TestResult[]) => void) | undefined;
  let skipFrame = false;
  let lastReport = 0;
  let duration = 0;
  let override: number | undefined;
  const publish = () => changed({ ...state });
  function cleanup() {
    const errors: unknown[] = [];
    for (const dispose of cleanups.splice(0).reverse()) { try { dispose(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Ошибка очистки теста');
  }
  function finish(status: TestResult['status'], error?: unknown) {
    try { cleanup(); } catch (cleanupError) { error = error ? new AggregateError([error, cleanupError], 'Ошибка теста и очистки') : cleanupError; }
    const test = queue[state.index - 1];
    if (test) state.results = [...state.results, { id: test.id, title: test.title, status: error ? 'failed' : status,
      metrics: frameMetrics(samples), ...(Object.keys(diagnostics).length ? { diagnostics } : {}), ...(error ? { error: errorMessage(error) } : {}) }];
    update = undefined;
    if (status === 'completed' && !error && state.index < queue.length) { begin(); return; }
    try { unlock?.(); } catch (unlockError) {
      state.results = [...state.results, { id: 'controls', title: 'Восстановление управления', status: 'failed', metrics: null, error: errorMessage(unlockError) }];
    }
    unlock = undefined;
    state = { ...state, running: false, progress: status === 'completed' && !error ? 1 : state.progress };
    resolve?.(state.results); resolve = undefined;
    publish();
  }
  function begin() {
    const test = queue[state.index];
    elapsed = 0; samples = []; diagnostics = {}; skipFrame = true; lastReport = 0;
    duration = override ?? test.durationSeconds;
    state = { ...state, index: state.index + 1, title: test.title, progress: 0 };
    try {
      update = test.setup({ onDispose: cleanup => cleanups.push(cleanup) }, values => {
        if (!Object.values(values).every(Number.isFinite)) throw new Error('Диагностика теста должна содержать конечные числа');
        diagnostics = { ...values };
      });
      update(0);
      publish();
    } catch (error) { finish('failed', error); }
  }
  return {
    getState: () => structuredClone(state),
    run(tests: readonly RunnableTest[], durationSeconds?: number): Promise<readonly TestResult[]> {
      if (state.running) return Promise.reject(new Error('Тест уже запущен'));
      if (!tests.length || tests.some(test => !Number.isFinite(test.durationSeconds) || test.durationSeconds <= 0 || test.durationSeconds > 300) ||
          (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300))) {
        return Promise.reject(new Error('Нужны тесты и длительность от 0 до 300 секунд (не включая 0)'));
      }
      queue = tests; override = durationSeconds;
      state = { running: true, title: '', progress: 0, index: 0, total: tests.length, results: [] };
      return new Promise(done => {
        resolve = done;
        try { unlock = lock(); begin(); } catch (error) { state.index = 1; finish('failed', error); }
      });
    },
    // First frame belongs to setup; the following second warms up rendering before measurement.
    advance(deltaMs: number) {
      if (!state.running || !update) return;
      if (skipFrame) { skipFrame = false; return; }
      if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
      const before = elapsed;
      elapsed += deltaMs / 1000;
      if (before >= 1) samples.push(deltaMs);
      state.progress = Math.min(1, elapsed / (duration + 1));
      try { update(Math.min(1, Math.max(0, (elapsed - 1) / duration))); }
      catch (error) { finish('failed', error); return; }
      if (elapsed >= duration + 1) { finish('completed'); return; }
      if (elapsed - lastReport >= 0.1) { lastReport = elapsed; publish(); }
    },
    stop() { if (state.running) finish('cancelled'); },
    fail(error: unknown) { if (state.running) finish('failed', error); },
  };
}
