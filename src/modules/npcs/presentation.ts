import { sampleNpc } from './headless.ts';

export function displayNpcPose(cycle: Parameters<typeof sampleNpc>[0],tick: number,phase?: number,pace?: number): ReturnType<typeof sampleNpc> {
  if (phase!==undefined || tick<cycle.endTick) return sampleNpc(cycle,tick,phase,pace);
  // Until the planner issues a successor, the old plan still reserves its endpoint.
  const last=sampleNpc(cycle,cycle.endTick)!;
  return {...last,mode:last.mode==='drive'?'drive':'idle',speed:0,steering:0,door:undefined,doorOpen:0};
}
