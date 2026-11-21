import { Frustum } from '@babylonjs/core/Maths/math.frustum.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DataList, Text } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import { defineModule, type CoreContext } from '../../core/context.ts';
import { createScope } from '../../core/scope.ts';
import { SceneCamera } from '../../core/fly-camera.ts';
import { geometryModule } from '../geometry/index.ts';
import { charactersModule } from '../characters/index.ts';
import { worldModule } from '../world/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { simulationModule } from '../simulation/index.tsx';
import { buildingInteriorsModule } from '../building-interiors/index.ts';
import { createTrafficCarAssets } from '../vehicles/index.tsx';
import { crowdTiming, crowdTrack, NPC_RADIUS, TRAFFIC_RADIUS } from './headless.ts';

import { streetSelection, PEOPLE_LIMIT, CAR_LIMIT } from './spacing.ts';
import { createPlanner } from './planner.ts';
import { displayNpcPose, npcLodCoverage, NPC_LOD_MARGIN, NPC_LOD_MS } from './presentation.ts';
import type { PlannerPlan } from './planner-protocol.ts';

type Pose = NonNullable<ReturnType<typeof displayNpcPose>>;
type Actor = {id:string;cycle:Extract<PlannerPlan,{kind:'resident'}>['plan']['cycle'];phase?:number;pace?:number};
type Candidate = Actor & {d:number;car:boolean;cell:string;existing:boolean;onScreen:boolean};
type View = {owner:ReturnType<typeof createScope>; actor:Actor; car:boolean; progress:number;
  draw:(pose:Pose,tick:number,id:string)=>void; fade:(coverage:number)=>void};

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
  requires:{geometry:geometryModule,world:worldModule, simulation:simulationModule, characters:charactersModule, interiors:buildingInteriorsModule, rendering:objectRenderingModule},
  setup({core,deps,scope}) {
    const planner=createPlanner(deps.world.getNavigationSource(),deps.world.collision,
      deps.world.getBuildingInteriorSources,scope);
    const cars=createTrafficCarAssets(core.scene,deps.geometry,scope);
    const views=new Map<string,View>();
    const reusable:View[]=[];
    const doorPoses=new Map<string,number>();
    deps.interiors.registerTrafficDoors(id=>doorPoses.get(id)??0,scope);
    scope.onDispose(()=>{
      for (const view of views.values()) view.owner.dispose();
      views.clear();
      while (reusable.length) reusable.pop()!.owner.dispose();
    });

    const probe=Vector3.Zero();
    let subscribed=0;
    let displayed: Actor[]=[];
    let selected=new Set<string>();
    let lastTick=-Infinity,lastX=Infinity,lastY=Infinity,lastZ=Infinity,lastFlyover=false,drawnTick=-1,lastRevision=-1;
    const observer=core.onFrame.add(delta=>{
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
          const existing=views.has(id),limit=(pose.mode==='drive'?TRAFFIC_RADIUS:NPC_RADIUS)+(existing?NPC_LOD_MARGIN:0);
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
        selected=new Set(displayed.map(actor=>actor.id));
      }
      const moved=refresh||drawnTick!==tick;
      drawnTick=tick;
      if (moved) doorPoses.clear();
      let people=0,activeCars=0;
      const step=delta/NPC_LOD_MS;
      for (const [id,view] of views) {
        if (!selected.has(id)) {
          view.progress=Math.max(0,view.progress-step);
          if (view.progress===0) {
            views.delete(id);
            if (view.car) view.owner.dispose(); else reusable.push(view);
            continue;
          }
        }
        if (view.car) activeCars++; else people++;
      }
      function show(view:View,pose:Pose,updatePose:boolean) {
        const distance=Math.hypot(x-pose.point[0],flyover?0:y-pose.point[1],z-pose.point[2]);
        view.fade(npcLodCoverage(view.progress,distance,view.car));
        if (updatePose) view.draw(pose,tick,view.actor.id);
      }
      for (const [id,view] of views) if (!selected.has(id)) {
        const {cycle,phase,pace}=view.actor;
        const pose=displayNpcPose(cycle,tick,phase,pace);
        if (pose) show(view,pose,moved);
      }
      let created=0;
      for (const actor of displayed) {
        const {id,cycle,phase,pace}=actor;
        const pose=displayNpcPose(cycle,tick,phase,pace);
        if (!pose) continue;
        if (moved && pose.door) doorPoses.set(pose.door,Math.max(doorPoses.get(pose.door)??0,pose.doorOpen));
        let view=views.get(id);
        const car=pose.mode==='drive';
        const needsView=!view;
        if (!view && (car?activeCars<CAR_LIMIT:people<PEOPLE_LIMIT)) {
          view=car?undefined:reusable.pop();
          if (!view && created<2) {
            const owner=createScope();
            try {
              if (car) {
                cars.load();
                const assets=cars.create(owner,id);
                if (assets) view={owner,actor,car,progress:0,draw:assets.draw,fade:assets.setFade};
              } else {
                const draw=deps.characters.createView(owner);
                view={owner,actor,car,progress:0,fade:draw.setFade,draw(p,tick,id) {
                  draw({tick,id,ownerId:'authority',x:p.point[0],y:p.point[1],z:p.point[2],yaw:p.yaw,
                    grounded:true,verticalSpeed:0,airborneTicks:0,landedTick:0,mode:'walk',stance:'standing',
                    boosted:false,moving:p.mode!=='idle',running:p.mode==='run',lastSequence:0},p.point[1]);
                }};
              }
            } finally {
              if (!view) owner.dispose();
            }
            if (view) created++;
          }
          if (view) {
            views.set(id,view);
            if (car) activeCars++; else people++;
          }
        }
        if (view) {
          view.actor=actor;
          view.progress=needsView?0:Math.min(1,view.progress+step);
          show(view,pose,needsView||moved);
        }
      }
      while (reusable.length) reusable.pop()!.owner.dispose();
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
