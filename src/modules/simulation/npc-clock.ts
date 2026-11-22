import { STEP_MS } from '../../simulation/authority.ts';

const DELAY_MS = 100;
const MAX_LEAD_MS = 250;
const MAX_RATE_ADJUSTMENT = .05;

export function createNpcClock() {
  let tick: number | undefined;
  let sampledAt = 0;
  return {
    reset() { tick = undefined; },
    sample(serverTick: number, arrival: number, now: number) {
      const target = Math.max(0, serverTick + (now - arrival - DELAY_MS) / STEP_MS);
      if (tick === undefined) {
        sampledAt = now;
        return tick = target;
      }
      const elapsed = (now - sampledAt) / STEP_MS;
      sampledAt = now;
      const error = target - (tick + elapsed);
      const adjustment = Math.max(-MAX_RATE_ADJUSTMENT, Math.min(MAX_RATE_ADJUSTMENT, error / 30));
      // A quiet socket can mean the room stopped. Limit prediction until a fresh server tick arrives.
      tick = Math.max(tick, Math.min(serverTick + MAX_LEAD_MS / STEP_MS, tick + elapsed * (1 + adjustment)));
      return tick;
    },
  };
}
