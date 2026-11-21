import type {TrafficRecovery, TrafficRejoin} from './headless.ts';
import type { Scope } from '../../core/modules.ts';
import type { CitySource } from '../world-generation/index.ts';
import type { BuildingInteriorSource, CollisionWorld } from '../world/index.ts';
import { plannerPackets } from './planner-input.ts';
import { movedPlannerQuery, plannerQueryDue, type PlannerPlan, type PlannerQuery, type PlannerRequest, type PlannerResponse } from './planner-protocol.ts';

export function createPlanner(city:CitySource,world:CollisionWorld,buildings:()=>readonly BuildingInteriorSource[],scope:Scope,recovered:(id:string,token:number,target:TrafficRejoin|null)=>void,
  changed:(plans:Iterable<PlannerPlan>)=>void) {
  const plans=new Map<string,PlannerPlan>();
  let population=0,error='',revision=0;
  let worker:Worker|undefined;
  let pending=false,more=false,ready=false;
  let uploadTimer:ReturnType<typeof setTimeout>|undefined;
  let previous:PlannerQuery|undefined;
  let upload:ReturnType<typeof plannerPackets>|undefined=plannerPackets(city,world,buildings);
  const close=()=>{
    clearTimeout(uploadTimer);
    worker?.terminate();
    worker=undefined;
    upload=undefined;
    plans.clear();
    changed(plans.values());
    revision++;
  };
  scope.onDispose(close);
  function failure(message:string) {
    error=message;
    close();
  }
  const send=(message:PlannerRequest)=>worker?.postMessage(message);
  function sendPackets() {
    if (!worker || !upload) return;
    try {
      const limit=performance.now()+2;
      do {
        const packet=upload.next();
        if (packet.done) {
          upload=undefined;
          send({type:'prepare'});
          return;
        }
        send({type:'data',batch:packet.value});
      } while (performance.now()<limit);
      uploadTimer=setTimeout(sendPackets,0);
    } catch (cause) { failure(cause instanceof Error?cause.message:String(cause)); }
  }
  try {
    worker=new Worker(new URL('./planner.worker.ts',import.meta.url),{type:'module'});
    const current=worker;
    current.onmessage=({data}:MessageEvent<PlannerResponse>)=>{
      if (worker!==current) return;
      if (data.type==='error') {failure(data.error);return;}
      if (data.type==='ready') {ready=true;return;}
      if (data.type==='recovered') {recovered(data.id,data.token,data.target);return;}
      pending=false;
      more=data.more;
      population=data.population;
      for (const id of data.removed) plans.delete(id);
      for (const plan of data.added) plans.set(plan.id,plan);
      if (data.removed.length || data.added.length) {revision++;changed(plans.values());}
    };
    current.onerror=event=>{if (worker===current) failure(event.message||'Планировщик NPC остановился.');};
    current.onmessageerror=()=>{if (worker===current) failure('Планировщик NPC вернул нечитаемые данные.');};
    send({type:'init',map:{id:city.id,version:city.version,bounds:city.bounds},spawn:world.spawn});
    uploadTimer=setTimeout(sendPackets,0);
  } catch (cause) { failure(cause instanceof Error?cause.message:String(cause)); }
  return {
    update(query:PlannerQuery) {
      if (!worker||pending) return;
      try {
        if (!ready || !plannerQueryDue(previous,query,more)) return;
        const moved=!previous || movedPlannerQuery(previous,query);
        pending=true;
        // Keep the exact observation point until movement warrants a new spatial scan.
        previous=moved?query:{...previous!,tick:query.tick};
        send({type:'query',query:previous});
      } catch (cause) { failure(cause instanceof Error?cause.message:String(cause)); }
    },
    recover(job:TrafficRecovery){send({type:'recover',job});},
    population:()=>population,
    ready:()=>ready,
    error:()=>error,
    revision:()=>revision,
  };
}
