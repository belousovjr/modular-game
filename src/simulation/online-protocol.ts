// shortcut: bump the protocol when the collision data or movement contract changes, automate the fingerprint before mixed-version deployment.
export const PROTOCOL = 3;
export const SNAPSHOT_TICKS = 3;
export const MAX_ROOM_PLAYERS = 16;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePacket(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}
