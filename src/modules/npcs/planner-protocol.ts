import type { CityMesh, CitySource } from '../world-generation/index.ts';
import type { BuildingInteriorSource, BuildingDoor, CollisionBox, CollisionWorld } from '../world/index.ts';
import type { createNpcAuthority } from './headless.ts';

type Authority = ReturnType<typeof createNpcAuthority>;
type Metadata = Pick<CitySource,'id'|'version'|'bounds'>;
export type PlannerQuery = {tick:number;origin:{x:number;z:number}|null};

export function movedObservation(a:PlannerQuery['origin'],b:PlannerQuery['origin']) {
  return a&&b?Math.hypot(a.x-b.x,a.z-b.z)>=4:a!==b;
}

export function plannerQueryDue(previous:PlannerQuery|undefined,next:PlannerQuery,more:boolean) {
  return !previous || more || next.tick-previous.tick>=6 || movedObservation(previous.origin,next.origin);
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
  | {type:'query';query:PlannerQuery};

export type PlannerPlan =
  | {kind:'resident';id:string;plan:ReturnType<Authority['presentation']>[number]}
  | {kind:'crowd';id:string;plan:ReturnType<Authority['crowdPresentation']>[number]};

export type PlannerResponse =
  | {type:'ready'}
  | {type:'frame';tick:number;population:number;added:readonly PlannerPlan[];removed:readonly string[];more:boolean}
  | {type:'error';error:string};
