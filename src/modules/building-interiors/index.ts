import { floorInRange, partitionInterior } from './floor-lod.ts';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { Scope } from '../../core/modules.ts';
import { defineModule } from '../../core/context.ts';
import { SceneCamera } from '../../core/fly-camera.ts';
import { createScope } from '../../core/scope.ts';
import { geometryModule } from '../geometry/index.ts';
import { materialsModule } from '../materials/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { DOOR_FRAME_TRIM, worldModule, type BuildingDoor, type BuildingProfile } from '../world/index.ts';
import { worldStreamingModule } from '../world-streaming/index.ts';
import { buildInterior, ENTRANCE_FLOOR_OFFSET, nearInterior } from './shell.ts';

type Leaf = {mesh:Mesh; direction:number};
type Box = readonly [number,number,number,number,number,number];
type Point = {x:number; y:number; z:number};

export const buildingInteriorsModule = defineModule({
  id:'building-interiors', title:'Внутренние фасады', category:'Окружение',
  requires:{world:worldModule, geometry:geometryModule, streaming:worldStreamingModule, materials:materialsModule, rendering:objectRenderingModule},
  setup({core,deps,scope}) {
    const active = new Map<string,{
      profile:BuildingProfile;
      leaves:Leaf[];
      update:(point:Point | undefined,opacity:number,actor:Point | null)=>void;
    }>();
    const doors = new Map(deps.world.collision.doors?.map(door=>[door.id,door]));
    let doorway: BuildingDoor | undefined;
    let leaves: Leaf[] = [], open = 0, opening = false;
    scope.onDispose(() => deps.materials.setDoorway(null));
    function selectDoor(door: BuildingDoor | undefined) {
      const next = door && active.get(door.id)?.leaves;
      if (door === doorway && (!door || leaves === next)) return;
      for (const {mesh} of leaves) {
        if (!mesh.isDisposed()) mesh.rotation.y = 0;
      }
      leaves = next ?? [];
      doorway = door;
      open = 0;
      opening = false;
      deps.materials.setDoorway(door ?? null);
    }
    function createDoor(door: BuildingDoor, profile: BuildingProfile, owner: Scope) {
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
      const half=door.width/2, trim=DOOR_FRAME_TRIM, top=door.height;
      const floorY = profile.origin[1] + profile.entrance.base + ENTRANCE_FLOOR_OFFSET;
      // Keep the foot of each jamb above the translucent floor and clear of its depth plane.
      const jambBottom = Math.max(0, floorY - door.y + .002);
      const frame=part('frame','interior-door-frame',[
        [-half-trim,-half,jambBottom,top+trim,-.09375,.86],
        [half,half+trim,jambBottom,top+trim,-.09375,.86],
        [-half,half,top,top+trim,-.09375,.86],
      ]);
      frame.position.set(door.x,door.y,door.z);
      frame.freezeWorldMatrix();
      const leaves: Leaf[] = [];
      for(const sign of [-1,1]){
        const hinge=sign*half, meeting=-hinge, gap=.004;
        const left=Math.min(0,meeting+sign*gap), right=Math.max(0,meeting+sign*gap);
        const handle=meeting+sign*.25;
        const mesh=part(String(sign),'interior-door',[
          [left,right,0,top,-.004,.076],
          [Math.max(left,meeting-.0625),Math.min(right,meeting+.0625),0,top,-.03,.10],
          [handle-.03125,handle+.03125,1,1.5,-.0625,.135],
        ]);
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
        const leaves = door ? createDoor(door,profile,owner) : [];
        let layout: ReturnType<typeof partitionInterior> | undefined;
        const rendered = new Map<number,{owner:ReturnType<typeof createScope>;slab:Mesh | undefined}>();
        function releaseFloors() {
          for (const {owner} of rendered.values()) owner.dispose();
          rendered.clear();
          layout=undefined;
        }
        function loadFloor(level:number,floor:ReturnType<typeof partitionInterior>[number]) {
          const resources=createScope();
          const prefix=`building-interiors/${id}/floor/${level}`;
          const metadata={buildingInterior:true,buildingInteriorLevel:level,shadowCaster:false,shadowReceiver:false};
          const mesh=(name:string,material:string,geometry:{positions:number[];indices:number[];uvs?:number[]})=>{
            if (!geometry.indices.length) return;
            const result=deps.geometry.createSurfaceMesh(prefix+name,material,geometry.positions,geometry.indices,resources,geometry.uvs);
            result.metadata={...result.metadata,...metadata};
            result.freezeWorldMatrix();
            return result;
          };
          try {
            mesh('','interior-concrete',floor.walls);
            const slab=mesh('/slab','interior-concrete',floor.slab);
            if (slab) {
              slab.metadata.buildingInteriorFloors=true;
              if (floor.stairRims.length) {
                const colors=new Float32Array(slab.getTotalVertices()*4).fill(1);
                for (const start of floor.stairRims) {
                  for (let i=start*4;i<(start+16)*4;i+=4) {
                    colors[i]=.57;
                    colors[i+1]=.58;
                    colors[i+2]=.60;
                  }
                }
                slab.setVerticesData('color',colors,false,4);
              }
            }
            mesh('/elevators','interior-door',floor.doors);
            mesh('/glass','interior-glass',floor.glass);
            const loaded={owner:resources,slab};
            rendered.set(level,loaded);
            return loaded;
          } catch (error) {
            resources.dispose();
            throw error;
          }
        }
        const update = (point: Point | undefined, opacity: number, actor: Point | null) => {
          const reach = layout ? 4 : 2;
          const cameraY=point && nearInterior(profile,point,reach) ? point.y : undefined;
          const actorY=actor && nearInterior(profile,actor,reach) ? actor.y : undefined;
          if (cameraY===undefined && actorY===undefined) {
            releaseFloors();
            return;
          }
          layout ??= partitionInterior(buildInterior(source));
          for (const [level,floor] of layout.entries()) {
            const visible=(cameraY!==undefined && floorInRange(floor,cameraY,profile.floorHeight)) ||
              (actorY!==undefined && floorInRange(floor,actorY,profile.floorHeight));
            const loaded=rendered.get(level);
            if (!visible) {
              if (loaded) {
                rendered.delete(level);
                loaded.owner.dispose();
              }
              continue;
            }
            const {slab}=loaded??loadFloor(level,floor);
            if (slab && slab.visibility!==opacity) slab.visibility=opacity;
          }
        };
        active.set(id,{profile,leaves,update});
        owner.onDispose(() => { active.delete(id); releaseFloors(); });
      }, scope, deps.world.buildingDetailRange);
    }
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      if (!active.size) {selectDoor(undefined);return;}
      const camera = core.scene.activeCamera;
      camera?.getViewMatrix();
      const opacity = camera instanceof SceneCamera ? .8 : 1;
      const point=camera?.globalPosition;
      const actor=deps.rendering.getDistanceOrigin();
      let selected:BuildingDoor|undefined, distance=Infinity, insideSelected=false;
      for (const [id,{profile,update}] of active) {
        update(point, opacity, actor);
        const door=doors.get(id);
        if(!point||!door)continue;
        const d=Math.min(doorDistance(door,point),actor?doorDistance(door,actor):Infinity);
        const inside=nearInterior(profile,point,0);
        if (!inside && (insideSelected || d>4.5)) continue;
        if (inside===insideSelected && d>=distance) continue;
        distance=d;
        selected=door;
        insideSelected=inside;
      }
      selectDoor(selected);
      if(!selected)return;
      const actorDistance=actor?doorDistance(selected,actor):Infinity;
      opening=actorDistance<=(opening?3:2.5);
      const step=Math.min(core.scene.getEngine().getDeltaTime(),50)/400;
      open=opening?Math.min(1,open+step):Math.max(0,open-step);
      for (const {mesh,direction} of leaves) mesh.rotation.y=direction*(5*Math.PI/12)*open;
    });
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return {};
  },
});
