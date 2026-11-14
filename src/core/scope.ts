import type { Scope } from './modules.ts';

export function createScope(): Scope & { dispose(): void } {
  let disposed = false;
  const cleanups: (() => void)[] = [];
  return {
    onDispose(cleanup) {
      if (disposed) cleanup(); else cleanups.push(cleanup);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      for (const cleanup of cleanups.splice(0).reverse()) {
        try { cleanup(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Ошибка очистки ресурсов');
    },
  };
}
