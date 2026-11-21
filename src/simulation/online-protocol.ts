import type { VehicleSnapshot } from '../modules/vehicles/headless.ts';
export { CAR_GUIDES } from '../modules/vehicles/headless.ts';
export type { VehicleCommand, VehicleSnapshot } from '../modules/vehicles/headless.ts';

// shortcut: bump the protocol when the collision data or movement contract changes, automate the fingerprint before mixed-version deployment.
export const PROTOCOL = 5;
export const SNAPSHOT_TICKS = 3;
export const MAX_ROOM_PLAYERS = 16;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePacket(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function finiteVector(value: unknown, size: number): value is number[] {
  return Array.isArray(value) && value.length === size && value.every(component => typeof component === 'number' && Number.isFinite(component));
}

export function readVehicle(value: unknown, tick: number): value is VehicleSnapshot {
  return record(value) && value.id === 'car/0' && value.tick === tick &&
    finiteVector(value.position, 3) && finiteRotation(value.rotation) &&
    Array.isArray(value.wheels) && value.wheels.length === 4 &&
    value.wheels.every(wheel => record(wheel) && finiteVector(wheel.position, 3) &&
      finiteRotation(wheel.rotation) && Number.isFinite(wheel.spin)) &&
    [value.speed, value.steering, value.leftDoor, value.rightDoor].every(Number.isFinite) &&
    (value.driverId === null || typeof value.driverId === 'string') &&
    (value.phase === 'parked' || value.phase === 'approaching' || value.phase === 'entering' ||
      value.phase === 'driving' || value.phase === 'exiting') && typeof value.message === 'string';
}

export function finiteRotation(value: unknown): value is number[] {
  return finiteVector(value, 4) && Math.abs(Math.hypot(...value) - 1) < 0.01;
}
