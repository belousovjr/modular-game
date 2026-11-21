import { liveNpcPose, NPC_RADIUS, TRAFFIC_RADIUS, type TrafficActor } from './headless.ts';

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
