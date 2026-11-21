export const ONLINE_DAY_MS = 2 * 60 * 60 * 1000;

export function onlineDayPhase(elapsedMs: number) {
  return elapsedMs % ONLINE_DAY_MS;
}

export function onlineDayHour(phaseMs: number) {
  return onlineDayPhase(phaseMs) / ONLINE_DAY_MS * 24;
}
