import { Frustum } from '@babylonjs/core/Maths/math.frustum.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { DataList, Text } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import { defineModule, type CoreContext } from '../../core/context.ts';
import { createScope } from '../../core/scope.ts';
import { SceneCamera } from '../../core/fly-camera.ts';
import { geometryModule } from '../geometry/index.ts';
import { charactersModule, npcAppearance } from '../characters/index.ts';
import { worldModule } from '../world/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { simulationModule } from '../simulation/index.tsx';
import { buildingInteriorsModule } from '../building-interiors/index.ts';
import { createTrafficCarAssets } from '../vehicles/index.tsx';
import { crowdTiming, crowdTrack, createTrafficActors, npcCorrectionActor, NPC_RADIUS, TRAFFIC_RADIUS, type TrafficActor } from './headless.ts';

import { streetSelection, PEOPLE_LIMIT, CAR_LIMIT } from './spacing.ts';
import { createPlanner } from './planner.ts';
import { blendNpcPose, createNpcPoseHandoff, npcLodCoverage, NPC_LOD_MARGIN, NPC_LOD_MS } from './presentation.ts';

type Pose = NonNullable<ReturnType<ReturnType<typeof createTrafficActors>['pose']>>;
type Actor = TrafficActor & {correctionOnly?:true};
type Candidate = Actor & {d:number;car:boolean;cell:string;existing:boolean;onScreen:boolean};
type View = {owner:ReturnType<typeof createScope>; actor:Actor; car:boolean; progress:number; body?:ReturnType<typeof npcAppearance>['body'];
  handoff?:ReturnType<typeof createNpcPoseHandoff>; draw:(pose:Pose,tick:number,id:string)=>void; fade:(coverage:number)=>void};

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
    let available:Actor[]=[];
    let subscribed=0;
    const traffic=createTrafficActors(job=>planner.recover(job));
    const planner=createPlanner(deps.world.getNavigationSource(),deps.world.collision,
      deps.world.getBuildingInteriorSources,scope,traffic.rejoin,plans=>{
        available=[];
        subscribed=0;
        for (const selection of plans) {
          subscribed++;
          if (selection.kind==='resident') {
            const {seed,cycle}=selection.plan;
            available.push({id:seed.id,cycle});
          } else {
            const {group,full,outdoors}=selection.plan;
            for(let slot=0;slot<group.count;slot++){
              const cycle=crowdTrack(full,outdoors,group,slot);
              available.push({id:`${group.recipe.id}/crowd/${slot}`,cycle,...crowdTiming(cycle,group,slot)});
            }
          }
        }
        traffic.replace(available);
      });
    if(!core.play)deps.characters.registerTrafficAuthority(traffic,scope);
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
    let displayed: Actor[]=[];
    const online=deps.simulation.online;
    let lastOnline=online.npcs();
    let overrides=new Map(lastOnline?.corrections.map(({id,pose})=>[id,pose]));
    let previousOverrides=overrides,previousTick=lastOnline?.tick??0;
    function latestPose(actor:Actor,tick:number,correctionTick:number):Pose|undefined {
      const target=overrides.get(actor.id);
      if(!target)return traffic.pose(actor,tick);
      const from=previousOverrides.get(actor.id),toTick=lastOnline?.tick??correctionTick;
      if(!from||correctionTick>=toTick||toTick===previousTick)return target;
      const alpha=Math.max(0,(correctionTick-previousTick)/(toTick-previousTick));
      return blendNpcPose(from,target,alpha);
    }
    let selected=new Set<string>();
    let lastTick=-Infinity,lastX=Infinity,lastY=Infinity,lastZ=Infinity,lastFlyover=false,drawnTick=-1,drawnCorrectionTick=-1,lastRevision=-1;
    const observer=core.onFrame.add(delta=>{
      const origin=deps.rendering.getDistanceOrigin();
      const x=origin?.x??Infinity,y=origin?.y??Infinity,z=origin?.z??Infinity;
      const flyover=core.scene.activeCamera instanceof SceneCamera;
      const tick=core.play?online.npcTick():deps.simulation.snapshot().tick;
      const correctionTick=core.play?online.npcCorrectionTick():tick;
      const hero=deps.characters.snapshot();
      const contactOrigin=Math.hypot(hero.x-x,hero.z-z)>8?{x:hero.x,z:hero.z}:null;
      const frame=online.npcs();
      const updated=lastOnline!==frame;
      if(updated){
        previousOverrides=overrides;previousTick=lastOnline?.tick??0;
        lastOnline=frame;overrides=new Map(frame?.corrections.map(({id,pose})=>[id,pose]));
      }
      if(core.play)planner.remote(frame);
      else planner.update({origin:origin?{x,z}:null,contactOrigin,tick});
      const revision=planner.revision();
      const refresh=updated||revision!==lastRevision || tick-lastTick>=6 || Math.hypot(x-lastX,flyover?0:y-lastY,z-lastZ)>=4 || flyover!==lastFlyover;
      if (refresh) {
        lastTick=tick; lastX=x; lastY=y; lastZ=z; lastFlyover=flyover;
        const candidates: Candidate[]=[];
        const camera=core.scene.activeCamera;
        const frustum=camera?Frustum.GetPlanes(camera.getTransformationMatrix()):[];
        function consider(actor:Actor) {
          const {id}=actor;
          let pose=latestPose(actor,tick,correctionTick);
          const previous=views.get(id)?.actor;
          if(core.play && !pose && previous && !previous.correctionOnly){
            actor=previous;
            pose=latestPose(actor,tick,correctionTick);
          }
          if (!pose) return;
          const dx=x-pose.point[0],dy=flyover?0:y-pose.point[1],dz=z-pose.point[2];
          const existing=previous!==undefined,limit=(pose.mode==='drive'?TRAFFIC_RADIUS:NPC_RADIUS)+(existing?NPC_LOD_MARGIN:0);
          const d=dx*dx+dy*dy+dz*dz;
          if (d>limit*limit || !Number.isFinite(d)) return;
          probe.set(pose.point[0],pose.point[1]+.9,pose.point[2]);
          const onScreen=frustum.every(plane=>plane.dotCoordinate(probe)>-3);
          candidates.push({...actor,existing,onScreen,
            cell:`${Math.floor(pose.point[0]/9)}/${Math.floor(pose.point[2]/9)}`,
            d:d-(existing?limit*limit:0)+(onScreen?0:20000)-(d<144?30000:0),car:pose.mode==='drive'});
        }
        lastRevision=revision;
        const current=new Map(available.map(actor=>[actor.id,actor]));
        for(const actor of traffic.exceptions())current.set(actor.id,actor);
        for(const id of frame?.suppressed??[])current.delete(id);
        for(const [id,pose] of overrides)if(!current.has(id))current.set(id,{...npcCorrectionActor(id,pose,tick),correctionOnly:true});
        for(const actor of current.values())consider(actor);
        displayed=streetSelection(candidates);
        selected=new Set(displayed.map(actor=>actor.id));
      }
      const moved=refresh||drawnTick!==tick||drawnCorrectionTick!==correctionTick;
      drawnTick=tick;
      drawnCorrectionTick=correctionTick;
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
        const id=view.actor.id;
        if ((updatePose || view.handoff?.active) && (!view.actor.correctionOnly || overrides.has(id))) {
          if (core.play) {
            view.handoff??=createNpcPoseHandoff();
            pose=view.handoff.sample(id,pose,overrides.has(id),delta,view.actor.cycle);
          }
          view.draw(pose,tick,id);
        }
      }
      for (const [id,view] of views) if (!selected.has(id)) {
        const pose=latestPose(view.actor,tick,correctionTick);
        if (pose) show(view,pose,moved);
      }
      let created=0;
      for (const actor of displayed) {
        const {id}=actor;
        const pose=latestPose(actor,tick,correctionTick);
        if (!pose) continue;
        if (moved && pose.door) doorPoses.set(pose.door,Math.max(doorPoses.get(pose.door)??0,pose.doorOpen));
        let view=views.get(id);
        const car=pose.mode==='drive';
        const needsView=!view;
        if (!view && (car?activeCars<CAR_LIMIT:people<PEOPLE_LIMIT)) {
          const appearance=car?undefined:npcAppearance(id);
          const match=appearance?reusable.findIndex(previous=>previous.body===appearance.body):-1;
          if(match>=0)view=reusable.splice(match,1)[0];
          if (!view && created<2) {
            const owner=createScope();
            try {
              if (car) {
                cars.load();
                const assets=cars.create(owner,id);
                if (assets) view={owner,actor,car,progress:0,draw:assets.draw,fade:assets.setFade};
              } else if(appearance) {
                const draw=deps.characters.createView(owner,appearance);
                let appearanceId=id;
                view={owner,actor,car,body:appearance.body,progress:0,fade:draw.setFade,draw(p,tick,id) {
                  if(id!==appearanceId){
                    appearanceId=id;
                    draw.setAppearance(npcAppearance(id));
                  }
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
