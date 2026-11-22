import type { NpcCheckpoint, NpcCrowd, NpcSeed, NpcSnapshot, TrafficPose } from '../modules/npcs/headless.ts';
import type { VehicleSnapshot } from '../modules/vehicles/headless.ts';
export { CAR_GUIDES } from '../modules/vehicles/headless.ts';
export type { VehicleCommand, VehicleSnapshot } from '../modules/vehicles/headless.ts';

// shortcut: bump the protocol when the collision data or movement contract changes, automate the fingerprint before mixed-version deployment.
export const PROTOCOL = 6;
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

export type NpcFrame = NpcSnapshot & {
  readonly population:number;
  readonly suppressed:readonly string[];
  readonly corrections:readonly {id:string;pose:TrafficPose}[];
};

function natural(value:unknown,max=Number.MAX_SAFE_INTEGER):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=max;
}
function npcSeed(value:unknown):value is NpcSeed {
  return record(value)&&typeof value.id==='string'&&value.id.length<=128&&
    natural(value.seed,0xffffffff)&&natural(value.personality,4)&&natural(value.startTick)&&
    typeof value.anchor==='string'&&typeof value.home==='string'&&typeof value.navigation==='string'&&
    (value.wait===undefined||natural(value.wait,14400))&&(value.crowd===undefined||value.crowd===true);
}
function npcGroup(value:unknown):value is NpcCrowd {
  return record(value)&&npcSeed(value.recipe)&&value.recipe.crowd===true&&natural(value.count,14)&&
    value.count>0&&Array.isArray(value.slots)&&value.slots.length===value.count&&
    value.slots.every(slot=>natural(slot,1439));
}
function npcSnapshot(value:unknown):value is NpcSnapshot & Record<string, unknown> {
  return record(value)&&natural(value.tick)&&Array.isArray(value.scenarios)&&value.scenarios.length<=1200&&
    value.scenarios.every(seed=>npcSeed(seed)&&!seed.crowd)&&Array.isArray(value.crowds)&&
    value.crowds.length<=13900&&value.crowds.every(npcGroup);
}
export function readNpcCheckpoint(value:unknown,navigation:string):(NpcCheckpoint & {wrecks:NpcFrame['corrections']})|undefined {
  if(!record(value)||!natural(value.attempts)||!natural(value.replacements)||!npcSnapshot(value))return;
  const all=[...value.scenarios,...value.crowds.map(group=>group.recipe)];
  if(all.some(seed=>seed.navigation!==navigation||seed.startTick>value.tick)||
     new Set(all.map(seed=>seed.id)).size!==all.length)return;
  return {tick:value.tick,attempts:value.attempts,replacements:value.replacements,scenarios:value.scenarios,crowds:value.crowds,wrecks:readNpcCorrections(value.wrecks)??[]};
}
function npcPose(value:unknown):value is TrafficPose {
  return record(value)&&finiteVector(value.point,3)&&
    ['yaw','pitch','distance','wheelDistance','speed','steering','doorOpen'].every(key=>Number.isFinite(value[key]))&&
    (value.mode==='walk'||value.mode==='run'||value.mode==='idle'||value.mode==='drive')&&
    (value.rotation===undefined||finiteRotation(value.rotation))&&(value.door===undefined||typeof value.door==='string');
}
function readNpcCorrections(value:unknown):NpcFrame['corrections']|undefined {
  if(!Array.isArray(value)||value.length>13900)return;
  if(value.every((entry):entry is NpcFrame['corrections'][number]=>record(entry)&&typeof entry.id==='string'&&npcPose(entry.pose)))return value;
}
export function readNpcFrame(value:unknown):NpcFrame|undefined {
  if(!record(value)||!natural(value.population,13900)||!Array.isArray(value.suppressed)||
    value.suppressed.length>13900||!value.suppressed.every(id=>typeof id==='string')||!npcSnapshot(value))return;
  const corrections=readNpcCorrections(value.corrections);
  if(!corrections)return;
  return {tick:value.tick,population:value.population,scenarios:value.scenarios,crowds:value.crowds,corrections,suppressed:value.suppressed};
}
