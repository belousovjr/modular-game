import type { CityMesh, CitySource } from '../world-generation/index.ts';
import type { BuildingInteriorSource, BuildingDoor, CollisionBox, CollisionWorld } from '../world/index.ts';
import type { createNpcAuthority, TrafficRecovery, TrafficRejoin } from './headless.ts';

type Authority = ReturnType<typeof createNpcAuthority>;
type Metadata = Pick<CitySource,'id'|'version'|'bounds'>;
export type PlannerQuery = {tick:number;origin:{x:number;z:number}|null;contactOrigin?:{x:number;z:number}|null};

export function movedObservation(a:PlannerQuery['origin'],b:PlannerQuery['origin']) {
  return a&&b?Math.hypot(a.x-b.x,a.z-b.z)>=4:a!==b;
}

export function movedPlannerQuery(a:PlannerQuery,b:PlannerQuery) {
  return movedObservation(a.origin,b.origin)||movedObservation(a.contactOrigin??null,b.contactOrigin??null);
}

export function plannerQueryDue(previous:PlannerQuery|undefined,next:PlannerQuery,more:boolean) {
  return !previous || more || next.tick-previous.tick>=6 || movedPlannerQuery(previous,next);
}

export type PlannerData =
  | {kind:'surface';meshes:readonly CityMesh[]}
  | {kind:'roads';roads:CitySource['roads']}
  | {kind:'crosswalks';crosswalks:NonNullable<CitySource['trafficLayout']>['crosswalks']}
  | {kind:'blockers';blockers:readonly CollisionBox[]}
  | {kind:'doors';doors:readonly BuildingDoor[]}
  | {kind:'interiors';interiors:readonly BuildingInteriorSource[]};

export type PlannerRequest =
  | {type:'init';map:Metadata;spawn:CollisionWorld['spawn']}
  | {type:'data';batch:readonly PlannerData[]}
  | {type:'prepare'}
  | {type:'query';query:PlannerQuery}
  | {type:'recover';job:TrafficRecovery};

export type PlannerPlan =
  | {kind:'resident';id:string;plan:ReturnType<Authority['presentation']>[number]}
  | {kind:'crowd';id:string;plan:ReturnType<Authority['crowdPresentation']>[number]};

export type PlannerResponse =
  | {type:'ready'}
  | {type:'recovered';id:string;token:number;target:TrafficRejoin|null}
  | {type:'frame';tick:number;population:number;added:readonly PlannerPlan[];removed:readonly string[];more:boolean}
  | {type:'error';error:string};
