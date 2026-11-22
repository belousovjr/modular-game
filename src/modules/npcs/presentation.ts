import { Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import { liveNpcPose, NPC_RADIUS, TRAFFIC_RADIUS, type TrafficActor, type TrafficPose } from './headless.ts';

export function displayNpcPose(cycle:TrafficActor['cycle'],tick:number,phase?:number,pace?:number) {
  return liveNpcPose({id:'',cycle,phase,pace},tick);
}

function smoothCoverage(value:number) {
  const t=Math.max(0,Math.min(1,value));
  return t*t*(3-2*t);
}

export const NPC_LOD_MARGIN=8;
export const NPC_LOD_MS=180;

export function npcLodCoverage(progress:number,distance:number,car:boolean) {
  const radius=car?TRAFFIC_RADIUS:NPC_RADIUS, width=car?28:16;
  return smoothCoverage(progress)*smoothCoverage((radius+NPC_LOD_MARGIN-distance)/width);
}

export function blendNpcPose(from: TrafficPose, target: TrafficPose, alpha: number): TrafficPose {
  const blend = (a: number, b: number) => a + (b - a) * alpha;
  const turn = Math.atan2(Math.sin(target.yaw - from.yaw), Math.cos(target.yaw - from.yaw));
  const rotationOf = (pose: TrafficPose) => pose.rotation
    ? Quaternion.FromArray(pose.rotation)
    : Quaternion.FromEulerAngles(pose.pitch, pose.yaw, 0);
  const rotation = from.rotation || target.rotation
    ? Quaternion.Slerp(rotationOf(from), rotationOf(target), alpha) : undefined;
  return {
    ...target,
    point: [blend(from.point[0], target.point[0]), blend(from.point[1], target.point[1]), blend(from.point[2], target.point[2])],
    yaw: from.yaw + turn * alpha,
    pitch: blend(from.pitch, target.pitch),
    speed: blend(from.speed, target.speed),
    wheelDistance: blend(from.wheelDistance, target.wheelDistance),
    rotation: rotation ? [rotation.x, rotation.y, rotation.z, rotation.w] : undefined,
  };
}

const HANDOFF_MS = 120;
const MAX_HANDOFF_DISTANCE = 2;

export function createNpcPoseHandoff() {
  let id: string | undefined;
  let corrected = false;
  let cycle: TrafficActor['cycle'] | undefined;
  let displayed: TrafficPose | undefined;
  let from: TrafficPose | undefined;
  let elapsed = 0;
  return {
    get active() { return from !== undefined; },
    sample(actorId: string, target: TrafficPose, useCorrection: boolean, delta: number, route?: TrafficActor['cycle']) {
      if (id !== actorId) {
        from = undefined;
      } else if (displayed && (corrected !== useCorrection || (!useCorrection && cycle !== route))) {
        const [x, y, z] = target.point;
        const [lastX, lastY, lastZ] = displayed.point;
        from = Math.hypot(lastX - x, lastY - y, lastZ - z) <= MAX_HANDOFF_DISTANCE ? displayed : undefined;
        elapsed = 0;
      } else if (from) {
        elapsed += delta;
        if (elapsed >= HANDOFF_MS) from = undefined;
      }
      id = actorId;
      corrected = useCorrection;
      cycle = route;
      displayed = from ? blendNpcPose(from, target, smoothCoverage(elapsed / HANDOFF_MS)) : target;
      return displayed;
    },
  };
}
