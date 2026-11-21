import { createInteriorCollision, createEntranceMotion, type InteriorQueryBounds, buildStairs, doorFrameParts, doorLeafParts, ENTRANCE_SWING, type DoorPose } from './headless.ts';
import { floorInRange } from './floor-lod.ts';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scope } from '../../core/modules.ts';
import { defineModule } from '../../core/context.ts';
import { SceneCamera } from '../../core/fly-camera.ts';
import { createScope } from '../../core/scope.ts';
import { geometryModule } from '../geometry/index.ts';
import { materialsModule } from '../materials/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { worldModule, type BuildingDoor, type BuildingProfile } from '../world/index.ts';
import { worldStreamingModule } from '../world-streaming/index.ts';
import { ENTRANCE_FLOOR_OFFSET, interiorViewHeight, nearInterior } from './shell.ts';

import type {LayoutRequest, LayoutResponse} from './interior-worker.ts';

type InteriorLayout = Exclude<LayoutResponse, {error:string}>;
type Leaf = {mesh:Mesh; direction:number};
type Box = readonly [number,number,number,number,number,number];
export type {DoorPose,InteriorCollisionBox,InteriorQueryBounds} from './headless.ts';
type Point = {x:number; y:number; z:number};

export const buildingInteriorsModule = defineModule({
  id:'building-interiors', title:'Внутренние фасады', category:'Окружение',
  requires:{world:worldModule, geometry:geometryModule, streaming:worldStreamingModule, materials:materialsModule, rendering:objectRenderingModule},
  setup({core,deps,scope}) {
    const active = new Map<string,{
      profile:BuildingProfile;
      leaves:Leaf[];
      doorReady:boolean;
      update:(point:Point | undefined,opacity:number,actor:Point | null,preparingEntrance:boolean)=>boolean;
    }>();
    let worker:Worker|undefined,uploadAvailable=false;
    scope.onDispose(()=>{worker?.terminate();worker=undefined;});
    function requestLayout(source:LayoutRequest,apply:(result:LayoutResponse)=>void){
      if(worker)return;
      const current=new Worker(new URL('./interior-worker.ts',import.meta.url),{type:'module'});
      worker=current;
      const cancel=()=>{
        if(worker!==current)return;
        current.terminate();
        worker=undefined;
      };
      const finish=(result:LayoutResponse)=>{
        if(worker!==current)return;
        cancel();
        apply(result);
      };
      current.onmessage=({data}:MessageEvent<LayoutResponse>)=>finish(data);
      current.onerror=event=>finish({error:event.message});
      try {
        current.postMessage(source);
      } catch (error) {
        cancel();
        throw error;
      }
      return cancel;
    }
    const doors = new Map(deps.world.collision.doors?.map(door=>[door.id,door]));
    const collision=createInteriorCollision(deps.world.getBuildingInteriorSources());
    const doorView=createEntranceMotion(deps.world.collision.doors??[]);
    let trafficDoorPose: ((id: string) => number) | undefined;
    let presentedDoors:readonly DoorPose[]|undefined;
    let presentedById=new Map<string,DoorPose>();
    let doorway: BuildingDoor | undefined;
    let open = 0, opening = false;
    scope.onDispose(() => deps.materials.setDoorway(null));
    scope.onDispose(() => deps.world.setInteriorView(false));
    function selectDoor(door: BuildingDoor | undefined) {
      if (door === doorway) return;
      doorway = door;
      open = 0;
      opening = false;
      deps.materials.setDoorway(door ?? null);
    }
    function createDoor(door: BuildingDoor, owner: Scope) {
      const {tx,tz}=door;
      const part = (name:string, surface:string, boxes:readonly Box[]) => {
        const positions:number[]=[], indices:number[]=[], uvs:number[]=[];
        function face(corners: readonly (readonly [number,number,number])[]) {
          const start=positions.length/3;
          const level=corners.every(([,y])=>y===corners[0][1]);
          const edge=corners.every(([u])=>u===corners[0][0]);
          for(const [u,y,depth] of corners){
            positions.push(u*tx+depth*tz,y,u*tz-depth*tx);
            uvs.push((edge?depth:u)/2,(level?depth:y)/2);
          }
          indices.push(start,start+1,start+2,start,start+2,start+3);
        }
        for(const [left,right,bottom,top,front,back] of boxes){
          face([[left,bottom,front],[left,top,front],[right,top,front],[right,bottom,front]]);
          face([[left,bottom,back],[right,bottom,back],[right,top,back],[left,top,back]]);
          face([[left,bottom,front],[left,bottom,back],[left,top,back],[left,top,front]]);
          face([[right,bottom,front],[right,top,front],[right,top,back],[right,bottom,back]]);
          face([[left,top,front],[left,top,back],[right,top,back],[right,top,front]]);
          face([[left,bottom,front],[right,bottom,front],[right,bottom,back],[left,bottom,back]]);
        }
        const mesh=deps.geometry.createSurfaceMesh(`interior-door/${door.id}/${name}`,surface,positions,indices,owner,uvs);
        mesh.metadata={...mesh.metadata,shadowCaster:false};
        return mesh;
      };

      // Match the baked entrance: 25 cm trim, 12.5 cm meeting stile and 6.25 cm handles.
      const half=door.width/2;
      const frame=part('frame','interior-door-frame',doorFrameParts(door));
      frame.position.set(door.x,door.y,door.z);
      frame.freezeWorldMatrix();
      const leaves: Leaf[] = [];
      for(const sign of [-1,1]){
        const hinge=sign*half;
        const mesh=part(String(sign),'interior-door',doorLeafParts(door,sign));
        const colors = new Float32Array(mesh.getTotalVertices()*4).fill(1);
        for (let i=24*4; i<colors.length; i+=4) {
          colors[i]=.55;
          colors[i+1]=.58;
          colors[i+2]=.63;
        }
        mesh.setVerticesData('color',colors,false,4);
        mesh.position.set(door.x+hinge*door.tx,door.y,door.z+hinge*door.tz);
        leaves.push({mesh,direction:-sign});
      }
      return leaves;
    }
    function doorDistance(door:BuildingDoor,point:Point){
      return Math.hypot(door.x-point.x,door.z-point.z,Math.max(door.y-point.y,0,point.y-door.y-door.height));
    }
    for (const source of deps.world.getBuildingInteriorSources()) {
      const {id, bounds, profile} = source;
      // Streaming follows the player when present, with room for the orbit camera.
      deps.streaming.registerSection(`building-interiors/${id}`, bounds, owner => {
        const door = doors.get(id);
        const leaves = door ? createDoor(door,owner) : [];
        let layout:InteriorLayout|undefined, cancelLayout:(()=>void)|undefined,failed=false;
        let uploading:{level:number;owner:ReturnType<typeof createScope>;steps:Generator<Mesh,Mesh|undefined>;waiting?:Mesh}|undefined;
        const rendered = new Map<number,{owner:ReturnType<typeof createScope>;slab:Mesh | undefined}>();
        function releaseFloors() {
          for (const {owner} of rendered.values()) owner.dispose();
          rendered.clear();
          uploading?.owner.dispose();
          uploading=undefined;
        }
        function* loadFloor(level:number,floor:InteriorLayout['floors'][number],resources:Scope,opacity:number):Generator<Mesh,Mesh|undefined> {
          const prefix=`building-interiors/${id}/floor/${level}`;
          const metadata={buildingInterior:true,shadowCaster:false};
          const mesh=(name:string,material:string,geometry:{positions:number[];indices:number[];uvs?:number[]})=>{
            if (!geometry.indices.length) return;
            const result=deps.geometry.createSurfaceMesh(prefix+name,material,geometry.positions,geometry.indices,resources,geometry.uvs);
            result.metadata={...result.metadata,...metadata};
            if (material==='interior-glass') result.metadata.shadowReceiver=false;
            result.freezeWorldMatrix();
            return result;
          };
          const low=level===0 ? profile.origin[1]+profile.entrance.base+ENTRANCE_FLOOR_OFFSET : floor.minY;
          const stairs=layout && level+1<layout.floors.length ? buildStairs(profile,layout.openings,low,floor.maxY) : undefined;
          const first=floor.walls.positions.length/3;
          const walls=mesh('','interior-concrete',stairs?.steps.indices.length?{
            positions:floor.walls.positions.concat(stairs.steps.positions),
            indices:floor.walls.indices.concat(stairs.steps.indices.map(index=>first+index)),
          }:floor.walls);
          if(walls)yield walls;
          const rails=stairs && mesh('/rails','interior-door-frame',stairs.rails);
          if(rails)yield rails;
          const frames=mesh('/window-frames','interior-door-frame',floor.windowFrames);
          if(frames)yield frames;
          const slab=mesh('/slab','interior-concrete',floor.slab);
          if(slab){
            slab.visibility=opacity;
            if(floor.stairRims.length){
              const colors=new Float32Array(slab.getTotalVertices()*4).fill(1);
              for(const start of floor.stairRims)for(let i=start*4;i<(start+16)*4;i+=4){
                colors[i]=.57;colors[i+1]=.58;colors[i+2]=.60;
              }
              slab.setVerticesData('color',colors,false,4);
            }
            yield slab;
          }
          const elevators=mesh('/elevators','interior-door',floor.doors);
          if(elevators)yield elevators;
          const glass=mesh('/glass','interior-glass',floor.glass);
          if(glass)yield glass;
          return slab;
        }
        let lastCameraY:number|undefined,lastActorY:number|undefined;
        const wanted:number[]=[];
        const update = (point: Point | undefined, opacity: number, actor: Point | null, preparingEntrance:boolean) => {
          const cameraY=interiorViewHeight(profile,point,preparingEntrance);
          const actorY=interiorViewHeight(profile,actor,preparingEntrance);
          if(cameraY===undefined&&actorY===undefined){
            cancelLayout?.();
            cancelLayout=undefined;
            releaseFloors();
            lastCameraY=lastActorY=undefined;wanted.length=0;
            return false;
          }
          if(!layout){
            if(!cancelLayout&&!failed)cancelLayout=requestLayout(source,result=>{
              cancelLayout=undefined;
              if('error' in result){failed=true;console.error('Interior layout',id,result.error);}
              else layout=result;
            });
            return false;
          }
          if(cameraY!==lastCameraY||actorY!==lastActorY){
            wanted.length=0;
            for(const [level,floor] of layout.floors.entries()){
              const visible=(cameraY!==undefined&&floorInRange(floor,cameraY,profile.floorHeight))||
                (actorY!==undefined&&floorInRange(floor,actorY,profile.floorHeight));
              if(visible)wanted.push(level);
              else if(rendered.has(level)){rendered.get(level)?.owner.dispose();rendered.delete(level);}
            }
            if(uploading&&!wanted.includes(uploading.level)){uploading.owner.dispose();uploading=undefined;}
            lastCameraY=cameraY;lastActorY=actorY;
          }
          const next=wanted.find(level=>!rendered.has(level));
          if(next!==undefined&&uploadAvailable){
            uploadAvailable=false;
            if(!uploading){
              const resources=createScope();
              uploading={level:next,owner:resources,steps:loadFloor(next,layout.floors[next],resources,opacity)};
            }
            const pending=uploading;
            try{
              if(!pending.waiting||pending.waiting.isReady(true)){
                const step=pending.steps.next();
                if(step.done){rendered.set(pending.level,{owner:pending.owner,slab:step.value});uploading=undefined;}
                else pending.waiting=step.value;
              }
            }catch(error){
              pending.owner.dispose();uploading=undefined;throw error;
            }
          }
          for(const {slab} of rendered.values())if(slab&&slab.visibility!==opacity)slab.visibility=opacity;
          return wanted.length>0&&wanted.every(level=>rendered.has(level));
        };
        active.set(id,{profile,leaves,doorReady:false,update});
        owner.onDispose(() => { active.delete(id); cancelLayout?.(); releaseFloors(); });
      }, scope, deps.world.buildingDetailRange);
    }
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      if (!active.size) {selectDoor(undefined);deps.world.setInteriorView(false);return;}
      const camera = core.scene.activeCamera;
      camera?.getViewMatrix();
      const opacity = camera instanceof SceneCamera ? .8 : 1;
      const point=camera?.globalPosition;
      const actor=deps.rendering.getDistanceOrigin();
      let selected:BuildingDoor|undefined, distance=Infinity, insideSelected=false, interiorView=false;
      let trafficSelected:BuildingDoor|undefined, trafficDistance=Infinity;
      for (const [id,{profile}] of active) {
        const inside=!!point&&nearInterior(profile,point,0);
        if (inside && presentedDoors && actor && nearInterior(profile,actor,0)) interiorView=true;
        const door=doors.get(id);
        if(!point||!door)continue;
        const d=Math.min(doorDistance(door,point),actor?doorDistance(door,actor):Infinity);
        if (trafficDoorPose?.(id) && d<trafficDistance) { trafficSelected=door; trafficDistance=d; }
        if (!inside && (insideSelected || d>4.5)) continue;
        if (inside===insideSelected && d>=distance) continue;
        distance=d;
        selected=door;
        insideSelected=inside;
      }
      deps.world.setInteriorView(interiorView);
      selectDoor(selected??trafficSelected);
      if (!presentedDoors && selected) {
        const actorDistance=actor?doorDistance(selected,actor):Infinity;
        opening=actorDistance<=(opening?3:2.5);
        const step=Math.min(core.scene.getEngine().getDeltaTime(),50)/400;
        open=opening?Math.min(1,open+step):Math.max(0,open-step);
      }
      uploadAvailable=true;
      const maxSwing=ENTRANCE_SWING*Math.min(core.scene.getEngine().getDeltaTime(),50)/400;
      for (const [id,view] of active) {
        const selectedDoor=selected?.id===id?selected:undefined;
        const visualOpen=selectedDoor?open:0;
        const state=presentedById.get(id);
        const traffic=trafficDoorPose?.(id)??0;
        const left=Math.max(traffic,presentedDoors?state?.left??0:visualOpen);
        const right=Math.max(traffic,presentedDoors?state?.right??0:visualOpen);
        const preparingEntrance=!!selectedDoor&&(left>0||right>0||!!actor&&doorDistance(selectedDoor,actor)<=3.5);
        const ready=view.update(point,opacity,actor,preparingEntrance);
        view.doorReady=(left>0||right>0)&&(ready||view.doorReady||traffic>0);
        for (const {mesh,direction} of view.leaves) {
          const angle=view.doorReady?direction*ENTRANCE_SWING*(direction>0?left:right):0;
          const change=angle-mesh.rotation.y;
          if(change)mesh.rotation.y+=Math.max(-maxSwing,Math.min(maxSwing,change));
        }
      }
    });
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return {
      collision,
      registerTrafficDoors(sample: (id: string) => number, owner: Scope) {
        trafficDoorPose=sample;
        owner.onDispose(()=>{if(trafficDoorPose===sample)trafficDoorPose=undefined;});
      },
      cameraObstacles(bounds:InteriorQueryBounds) {
        const result=collision.along(bounds);
        result.push(...doorView.viewAlong(bounds,presentedById));
        return result;
      },
      presentDoorSnapshot(snapshot:readonly DoorPose[]|undefined) {
        if (snapshot===presentedDoors) return;
        presentedDoors=snapshot;
        presentedById=new Map(snapshot?.map(door=>[door.id,door]));
      },
    };
  },
});
