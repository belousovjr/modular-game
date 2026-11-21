import { Frustum } from '@babylonjs/core/Maths/math.frustum.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DataList, Text } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import { defineModule, type CoreContext } from '../../core/context.ts';
import { createScope } from '../../core/scope.ts';
import { SceneCamera } from '../../core/fly-camera.ts';
import { charactersModule } from '../characters/index.ts';
import { worldModule } from '../world/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { simulationModule } from '../simulation/index.tsx';
import { buildingInteriorsModule } from '../building-interiors/index.ts';
import { createTrafficCarAssets } from '../vehicles/index.tsx';
import { crowdTiming, crowdTrack, NPC_RADIUS, TRAFFIC_RADIUS } from './headless.ts';

import { streetSelection } from './spacing.ts';
import { createPlanner } from './planner.ts';
import { displayNpcPose } from './presentation.ts';
import type { PlannerPlan } from './planner-protocol.ts';

type Pose = NonNullable<ReturnType<typeof displayNpcPose>>;
type Actor = {id:string;cycle:Extract<PlannerPlan,{kind:'resident'}>['plan']['cycle'];phase?:number;pace?:number};
type Candidate = Actor & {d:number;car:boolean;cell:string;existing:boolean;onScreen:boolean};
type Diagnostics = { population: number; subscribed: number; people: number; cars: number; ready: boolean; error: string };

function NpcInfo({read,onFrame}: {read:()=>Diagnostics; onFrame:CoreContext['onFrame']}) {
  const [info,setInfo]=useState(read);
  useEffect(()=>{
    let elapsed=0;
    const observer=onFrame.add(delta=>{
      elapsed+=delta;
      if (elapsed>=250) { elapsed=0; setInfo(read()); }
    });
    return ()=>{onFrame.remove(observer);};
  },[read,onFrame]);
  return <>
    <DataList.Root>
      <DataList.Item><DataList.Label>Население города</DataList.Label><DataList.Value>{info.population}</DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Навигация</DataList.Label><DataList.Value>{info.ready?'Готова':'Подготовка карты'}</DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Сценарии рядом</DataList.Label><DataList.Value>{info.subscribed}</DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Пешеходы рядом</DataList.Label><DataList.Value>{info.people}</DataList.Value></DataList.Item>
      <DataList.Item><DataList.Label>Машины рядом</DataList.Label><DataList.Value>{info.cars}</DataList.Value></DataList.Item>
    </DataList.Root>
    {info.error && <Text as="p" color="red">{info.error}</Text>}
  </>;
}

export const npcsModule=defineModule({
  id:'npcs', title:'Жители города', category:'Игра',
  requires:{world:worldModule, simulation:simulationModule, characters:charactersModule, interiors:buildingInteriorsModule, rendering:objectRenderingModule},
  setup({core,deps,scope}) {
    const planner=createPlanner(deps.world.getNavigationSource(),deps.world.collision,
      deps.world.getBuildingInteriorSources,scope);
    const cars=createTrafficCarAssets(core.scene,scope);
    const views=new Map<string,{owner:ReturnType<typeof createScope>; car:boolean; born:number; draw:(pose:Pose,tick:number,id:string)=>void; fade?:(coverage:number)=>void}>();
    const doorPoses=new Map<string,number>();
    deps.interiors.registerTrafficDoors(id=>doorPoses.get(id)??0,scope);
    scope.onDispose(()=>{
      for (const view of views.values()) view.owner.dispose();
      views.clear();
    });

    const probe=Vector3.Zero();
    let subscribed=0;
    let displayed: Actor[]=[];
    let lastTick=-Infinity,lastX=Infinity,lastY=Infinity,lastZ=Infinity,lastFlyover=false,drawnTick=-1,lastRevision=-1;
    const observer=core.onFrame.add(()=>{
      const origin=deps.rendering.getDistanceOrigin();
      const x=origin?.x??Infinity,y=origin?.y??Infinity,z=origin?.z??Infinity;
      const flyover=core.scene.activeCamera instanceof SceneCamera;
      const tick=deps.simulation.snapshot().tick;
      planner.update({origin:origin?{x,z}:null,tick});
      const revision=planner.revision();
      const refresh=revision!==lastRevision || tick-lastTick>=6 || Math.hypot(x-lastX,flyover?0:y-lastY,z-lastZ)>=4 || flyover!==lastFlyover;
      if (refresh) {
        lastTick=tick; lastX=x; lastY=y; lastZ=z; lastFlyover=flyover; lastRevision=revision;
        subscribed=0;
        const candidates: Candidate[]=[];
        const camera=core.scene.activeCamera;
        const frustum=camera?Frustum.GetPlanes(camera.getTransformationMatrix()):[];
        function consider(id: string,cycle: Actor['cycle'],phase?: number,pace?: number) {
          const pose=displayNpcPose(cycle,tick,phase,pace);
          if (!pose) return;
          const dx=x-pose.point[0],dy=flyover?0:y-pose.point[1],dz=z-pose.point[2];
          const existing=views.has(id),limit=(pose.mode==='drive'?TRAFFIC_RADIUS:NPC_RADIUS)+(existing?8:0);
          const d=dx*dx+dy*dy+dz*dz;
          if (d>limit*limit || !Number.isFinite(d)) return;
          probe.set(pose.point[0],pose.point[1]+.9,pose.point[2]);
          const onScreen=frustum.every(plane=>plane.dotCoordinate(probe)>-3);
          candidates.push({id,cycle,phase,pace,existing,onScreen,
            cell:`${Math.floor(pose.point[0]/9)}/${Math.floor(pose.point[2]/9)}`,
            d:d-(existing?limit*limit:0)+(onScreen?0:20000),car:pose.mode==='drive'});
        }
        for (const selection of planner.plans()) {
          subscribed++;
          if (selection.kind==='resident') {
            const {seed,cycle}=selection.plan;
            if (tick>=seed.startTick) consider(seed.id,cycle);
          } else {
            const {group,full,outdoors}=selection.plan;
            if (tick<group.recipe.startTick) continue;
            for (let slot=0;slot<group.count;slot++) {
              const cycle=crowdTrack(full,outdoors,group,slot);
              const {phase,pace}=crowdTiming(cycle,group,slot);
              consider(`${group.recipe.id}/crowd/${slot}`,cycle,phase,pace);
            }
          }
        }
        displayed=streetSelection(candidates);
      }
      if (!refresh && drawnTick===tick && views.size===displayed.length) return;
      drawnTick=tick;
      doorPoses.clear();
      const visible=displayed.flatMap(({id,cycle,phase,pace})=>{
        const pose=displayNpcPose(cycle,tick,phase,pace);
        return pose?[{id,pose}]:[];
      });
      for (const {pose} of visible)
        if (pose.door) doorPoses.set(pose.door,Math.max(doorPoses.get(pose.door)??0,pose.doorOpen));
      const active=new Set(visible.map(a=>a.id));
      const reusable=[...views.keys()].filter(id=>!active.has(id)&&!views.get(id)?.car);
      let created=0;
      for (const {id,pose} of visible) {
        let view=views.get(id);
        if (!view && pose.mode!=='drive') {
          const oldId=reusable.pop();
          if (oldId) {
            view=views.get(oldId)!;
            views.delete(oldId);
            view.born=tick;
            views.set(id,view);
          }
        }
        if (!view && created<2) {
          const owner=createScope();
          try {
            if (pose.mode==='drive') {
              cars.load();
              const draw=cars.create(owner,id);
              if (draw) view={owner,car:true,born:tick,draw};
            } else {
              const draw=deps.characters.createView(owner);
              view={owner,car:false,born:tick,fade:draw.setFade,draw(p,tick,id) {
                draw({tick,id,ownerId:'authority',x:p.point[0],y:p.point[1],z:p.point[2],yaw:p.yaw,
                  grounded:true,verticalSpeed:0,airborneTicks:0,landedTick:0,mode:'walk',stance:'standing',
                  boosted:false,moving:p.mode!=='idle',running:p.mode==='run',lastSequence:0},p.point[1]);
              }};
            }
          } finally {
            if (!view) owner.dispose();
          }
          if (view) {
            views.set(id,view);
            created++;
          }
        }
        if (view?.fade) {
          const d=Math.hypot(x-pose.point[0],flyover?0:y-pose.point[1],z-pose.point[2]);
          view.fade(Math.max(0,Math.min(1,(tick-view.born)/14,(NPC_RADIUS+8-d)/16)));
        }
        view?.draw(pose,tick,id);
      }
      for (const [id,view] of views) if (!active.has(id)) {
        view.owner.dispose();
        views.delete(id);
      }
    });
    scope.onDispose(()=>core.onFrame.remove(observer));
    const diagnostics=()=>{
      const activeCars=[...views.values()].filter(view=>view.car).length;
      return {population:planner.population(),subscribed,people:views.size-activeCars,cars:activeCars,
        ready:planner.ready(),
        error:planner.error() || cars.status() || (deps.characters.getAssetStatus().error??'')};
    };
    scope.onDispose(core.panels.register('npcs','Жители города',<NpcInfo read={diagnostics} onFrame={core.onFrame}/>));
    return {diagnostics};
  },
});
