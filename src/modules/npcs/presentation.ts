import { NPC_RADIUS, sampleNpc, TRAFFIC_RADIUS } from './headless.ts';

export function displayNpcPose(cycle: Parameters<typeof sampleNpc>[0],tick: number,phase?: number,pace?: number): ReturnType<typeof sampleNpc> {
  if (phase!==undefined || tick<cycle.endTick) return sampleNpc(cycle,tick,phase,pace);
  // Until the planner issues a successor, the old plan still reserves its endpoint.
  const last=sampleNpc(cycle,cycle.endTick)!;
  return {...last,mode:last.mode==='drive'?'drive':'idle',speed:0,steering:0,door:undefined,doorOpen:0};
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
