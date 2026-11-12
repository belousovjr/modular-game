export const STEP_MS = 1000 / 60;
export interface Snapshot { readonly tick: number; readonly seconds: number; readonly pendingTicks: number }
export interface Authority {
  advance(elapsedMs: number): void;
  snapshot(): Snapshot;
}
// shortcut: local authority has no transport, add a remote adapter when a server exists.
export function createLocalAuthority(): Authority {
  let elapsed = 0;
  let tick = 0;
  return {
    advance(elapsedMs) {
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid elapsed time');
      elapsed += elapsedMs;
      const due = Math.floor((elapsed + 1e-7) / STEP_MS);
      // Retain all debt; cap work per call, never discard elapsed time.
      const target = Math.min(due, tick + 240);
      while (tick < target) tick++;
    },
    snapshot() {
      return Object.freeze({ tick, seconds: tick / 60, pendingTicks: Math.max(0, Math.floor((elapsed + 1e-7) / STEP_MS) - tick) });
    },
  };
}
