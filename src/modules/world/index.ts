import type {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { defineModule } from '../../core/context.ts';
import { objectTemplatesModule } from '../object-templates/index.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';
import { worldStreamingModule, type SectionBounds } from '../world-streaming/index.ts';
import { worldGenerationModule } from '../world-generation/index.ts';
import { worldTemplates } from './templates.ts';
import {cityTemplates,toCityGrid} from './city-templates.ts';
import {citySource} from './city.ts';
import {createTreeBatch,createTreeMaterial,groupTrees,treeLodBounds} from './trees.ts';
import {groupBuildingSurfaces} from './building-batches.ts';
import {aviationLightPositions,createAviationLights} from './aviation-lights.ts';
import reviewRoute from './data/downtown/review-route.json' with {type:'json'};
import district from './data/downtown/district.json' with {type:'json'};
import {cityCollision} from './headless.ts';
import {geometryModule} from '../geometry/index.ts';
import {distantSurfaces,groupDistantSurfaces,groupStreetSurfaces} from './distant-surfaces.ts';
import {createElement} from 'react';
import {Link} from '@radix-ui/themes';
export type { CollisionWorld, CollisionBox } from './headless.ts';
export interface StreetLightAnchor {readonly id:string;readonly street:string;readonly x:number;readonly y:number;readonly z:number}

export const worldModule = defineModule({
  id: 'world', title: 'Центр Чикаго', category: 'Окружение',
  requires: { generator: worldGenerationModule, geometry:geometryModule, templates: objectTemplatesModule, rendering: objectRenderingModule, streaming: worldStreamingModule },
  setup({ core, deps, scope }) {
    const city=deps.generator.generateCity(citySource);
    scope.onDispose(core.panels.register('world','Центр Чикаго',createElement(Link,{href:'https://www.openstreetmap.org/copyright',target:'_blank',rel:'noreferrer'},'© OpenStreetMap contributors · ODbL · Рельеф USGS 3DEP')));
    const generated=city.chunks.map(c=>({schemeId:c.id,bounds:c.bounds,objectCount:c.meshes.length+(c.details??[]).reduce((n,d)=>n+d.meshes.length,0)+city.placements.filter(p=>p.position[0]>=c.bounds.minX&&p.position[0]<c.bounds.maxX&&p.position[2]>=c.bounds.minZ&&p.position[2]<c.bounds.maxZ).length}));
    for(const template of cityTemplates)deps.templates.register(toCityGrid(template),scope);
    for (const template of worldTemplates) deps.templates.register(template.id==='world/lamp'?toCityGrid(template):template, scope);
    const aviationLights=aviationLightPositions(city,p=>deps.templates.resolve(p.templateId,p.parameters).levels[0].parts);
    const updateAviationLights=createAviationLights(core.scene,scope,aviationLights);
    const buildings = new Set<ReturnType<typeof deps.rendering.createObject>>();
    const lamps: typeof buildings = new Set();
    const placements = city.placements.filter(p=>p.templateId!=='city/stone'&&p.templateId!=='city/glass'&&p.templateId!=='city/tree');
    const buildingCount=city.colliders.length;
    const lampCount = placements.filter(p => p.templateId === 'city/signal' || p.templateId === 'world/lamp').length;
    const sections = new Map<string, { bounds: SectionBounds; placements: typeof placements }>();
    for (const placement of placements) {
      const [x, , z] = placement.position;
      const streetProp = placement.templateId === 'world/lamp' || placement.templateId === 'city/signal' || placement.key.startsWith('authored/daley/');
      const key = placement.templateId === 'world/terrain' ? placement.key : `${Math.floor(x / 128)}/${Math.floor(z / 128)}/${streetProp?'street':'skyline'}`;
      // Include full surfaces and facade overhangs, so long tiles survive near a section boundary.
      const halfX = placement.templateId === 'city/signal' ? (placement.parameters.armLength ?? 4) + .5 : (placement.parameters.width ?? 2) / 2 + 4;
      const halfZ = placement.templateId === 'city/signal' ? (placement.parameters.armLength ?? 4) + .5 : (placement.parameters.depth ?? 2) / 2 + 4;
      const bounds = { minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ };
      const section = sections.get(key);
      if (section) {
        section.bounds = { minX: Math.min(section.bounds.minX, bounds.minX), maxX: Math.max(section.bounds.maxX, bounds.maxX),
          minZ: Math.min(section.bounds.minZ, bounds.minZ), maxZ: Math.max(section.bounds.maxZ, bounds.maxZ) };
        section.placements.push(placement);
      } else sections.set(key, { bounds, placements: [placement] });
    }
    for (const [key, section] of sections) {
      deps.streaming.registerSection(`${city.id}/objects/${key}`, section.bounds, owner => {
        for (const placement of section.placements) {
          const surface = placement.templateId.slice('world/'.length);
          const batchMaterial = ['road', 'sidewalk', 'curb'].includes(surface) ? surface : undefined;
          const object = deps.rendering.createObject(placement.templateId, placement.key, placement.parameters, owner, 'static', batchMaterial,batchMaterial?0:180);
          object.root.position.copyFromFloats(...placement.position);
          object.root.rotation.copyFromFloats(...placement.rotation);
          const list = placement.templateId === 'city/signal' || placement.templateId === 'world/lamp' ? lamps : placement.key.startsWith('authored/daley/') ? undefined : buildings;
          if (list) { list.add(object); owner.onDispose(() => list.delete(object)); }
        }
      }, scope,section.placements.some(p=>p.templateId!=='city/signal'&&p.templateId!=='world/lamp'&&!p.key.startsWith('authored/daley/'))?{load:1200,unload:1400,unloadDelayMs:250}:{load:192,unload:256,unloadDelayMs:250});
    }
    type Visibility=ReturnType<typeof deps.rendering.createVisibility>;
    const surfaceViews=new Set<{bounds:SectionBounds;load:number;unload:number;visibility:Visibility}>();
    const bandViews=new Set<{meshes:Mesh[];bounds:SectionBounds;minY:number;maxY:number;count:number;load:number;unload:number;visibility?:Visibility}>();
    const heights=new Map(city.placements.map(p=>[p.key,p.parameters.height]));
    const treeGroups=groupTrees(city.placements);
    const treeViews=new Set<(point:ReturnType<typeof deps.rendering.getDistanceOrigin>)=>void>();
    if(treeGroups.size){
      const material=createTreeMaterial(core.scene,scope);
      for(const [key,{trees,bounds,minY,maxY}] of treeGroups){
        const id=`${city.id}/trees/${key}`;
        deps.streaming.registerSection(id,bounds,owner=>{
          function level(far:boolean){
            let mesh:Mesh|undefined,previousLower=0,previousUpper=0;
            return (lower:number,upper:number)=>{
              if(lower===previousLower&&upper===previousUpper)return;
              previousLower=lower;previousUpper=upper;
              if(upper<=lower){mesh?.setEnabled(false);return;}
              if(!mesh){
                mesh=createTreeBatch(`${id}/${far?'far':'near'}`,trees,material,owner,far);
                deps.geometry.registerMeshes([mesh],owner);
              }
              deps.geometry.setMeshFade(mesh,lower,upper);
              mesh.setEnabled(true);
            };
          }
          const near=level(false),far=level(true);
          const update=(point:ReturnType<typeof deps.rendering.getDistanceOrigin>)=>{
            if(!point){near(0,0);far(0,0);return;}
            const horizontal=Math.hypot(Math.max(bounds.minX-point.x,0,point.x-bounds.maxX),Math.max(bounds.minZ-point.z,0,point.z-bounds.maxZ));
            const distance=Math.hypot(horizontal,Math.max(minY-point.y,0,point.y-maxY));
            const {coverage,split}=treeLodBounds(distance,horizontal);
            far(0,split);
            near(split,coverage);
          };
          treeViews.add(update);
          owner.onDispose(()=>treeViews.delete(update));
        },scope,{load:210,unload:225});
      }
    }
    for(const band of [{meshes:groupDistantSurfaces(city),load:1200,unload:1400},{meshes:groupStreetSurfaces(city),load:192,unload:256}])for(const surface of band.meshes){
      const bounds={minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity};
      for(let i=0;i<surface.positions.length;i+=3){bounds.minX=Math.min(bounds.minX,surface.positions[i]);bounds.maxX=Math.max(bounds.maxX,surface.positions[i]);bounds.minZ=Math.min(bounds.minZ,surface.positions[i+2]);bounds.maxZ=Math.max(bounds.maxZ,surface.positions[i+2]);}
      deps.streaming.registerSection(surface.id,bounds,owner=>{
        const material=surface.surface==='road-base'?'road':surface.surface;
        const mesh=deps.geometry.createSurfaceMesh(surface.id,material,surface.positions,surface.indices,owner);
        mesh.metadata={...mesh.metadata,citySurface:material,distantGround:band.load===1200,shadowCaster:false};mesh.freezeWorldMatrix();
        const view={bounds,load:band.load,unload:band.unload,visibility:deps.rendering.createVisibility([mesh],owner)};surfaceViews.add(view);owner.onDispose(()=>surfaceViews.delete(view));
      },scope,{load:band.load,unload:band.unload,unloadDelayMs:250});
    }
    const nearby={id:'surfaces',minHeight:0,maxHeight:0,load:192,unload:256};
    const skyline=groupBuildingSurfaces(city);
    const surfaceSections=[
      ...city.chunks.map(chunk=>({chunk,band:nearby,distant:false,bounds:{...chunk.bounds},
        surfaces:chunk.meshes.filter(m=>!m.surface.startsWith('city-')&&!distantSurfaces.has(m.surface)&&m.surface!=='road'&&m.surface!=='sidewalk')})),
      ...skyline.flatMap(chunk=>district.buildingLod.map(band=>({chunk,band,distant:true,bounds:{minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity},
        surfaces:chunk.meshes.filter(m=>m.surface.endsWith('-'+band.id))}))),
    ];
    for(const {chunk,band,distant,bounds,surfaces} of surfaceSections) {
      if(!surfaces.length)continue;
      let minY=Infinity,maxY=-Infinity;
      for(const surface of surfaces)for(let i=0;i<surface.positions.length;i+=3){bounds.minX=Math.min(bounds.minX,surface.positions[i]);bounds.maxX=Math.max(bounds.maxX,surface.positions[i]);bounds.minZ=Math.min(bounds.minZ,surface.positions[i+2]);bounds.maxZ=Math.max(bounds.maxZ,surface.positions[i+2]);minY=Math.min(minY,surface.positions[i+1]);maxY=Math.max(maxY,surface.positions[i+1]);}
      const count=distant?chunk.buildingIds.filter(id=>{const h=heights.get(id);return h!==undefined&&h>=band.minHeight&&h<band.maxHeight;}).length:0;
      deps.streaming.registerSection(`${chunk.id}/${distant?'buildings-':''}${band.id}`,bounds,owner=>{
        const meshes:Mesh[]=[];
        const view:{meshes:Mesh[];bounds:SectionBounds;minY:number;maxY:number;count:number;load:number;unload:number;visibility?:Visibility}={meshes,bounds,minY,maxY,count,load:band.load,unload:band.unload};
        if(distant){bandViews.add(view);owner.onDispose(()=>bandViews.delete(view));}
        for(const surface of surfaces) {
          const material=distant?surface.surface.slice(0,-band.id.length-1):surface.surface;
          const mesh=deps.geometry.createSurfaceMesh(`${chunk.id}/${surface.surface}`,material,surface.positions,surface.indices,owner,surface.uvs);
          mesh.metadata={...mesh.metadata,citySurface:material,buildingBand:distant?band.id:undefined,shadowCaster:distant||['bank','facade','foundation','metal','roof'].includes(material)};mesh.freezeWorldMatrix();view.meshes.push(mesh);
        }
        if(distant)view.visibility=deps.rendering.createVisibility(meshes,owner);
        else {const surfaceView={bounds,load:band.load,unload:band.unload,visibility:deps.rendering.createVisibility(meshes,owner)};surfaceViews.add(surfaceView);owner.onDispose(()=>surfaceViews.delete(surfaceView));}
      },scope,{load:band.load,unload:band.unload,unloadDelayMs:250});
    }
    const detailViews=new Set<{meshes:Mesh[];bounds:SectionBounds;minY:number;maxY:number;visibility?:Visibility}>();
    for(const chunk of city.chunks)for(const detail of chunk.details??[]) {
      deps.streaming.registerSection(detail.id,detail.bounds,owner=>{
        const meshes:Mesh[]=[];
        const view:{meshes:Mesh[];bounds:SectionBounds;minY:number;maxY:number;visibility?:Visibility}={meshes,bounds:detail.bounds,minY:Infinity,maxY:-Infinity};
        detailViews.add(view);owner.onDispose(()=>detailViews.delete(view));
        for(const surface of detail.meshes){
          const material=surface.surface.replace(/-detail$/,'');
          const mesh=deps.geometry.createSurfaceMesh(`${detail.id}/${material}`,material,surface.positions,surface.indices,owner,surface.uvs);
          mesh.metadata={...mesh.metadata,citySurface:material,buildingDetail:true,shadowNearOnly:true,shadowCaster:true};mesh.freezeWorldMatrix();
          view.meshes.push(mesh);
          for(let i=1;i<surface.positions.length;i+=3){view.minY=Math.min(view.minY,surface.positions[i]);view.maxY=Math.max(view.maxY,surface.positions[i]);}
        }
        view.visibility=deps.rendering.createVisibility(meshes,owner);
      },scope,{load:24,unload:32,unloadDelayMs:250});
    }
    const detailObserver=core.scene.onBeforeRenderObservable.add(()=>{
      const point=deps.rendering.getDistanceOrigin();
      updateAviationLights(point);
      for(const update of treeViews)update(point);
      for(const view of surfaceViews){
        const b=view.bounds,distance=point?Math.hypot(Math.max(b.minX-point.x,0,point.x-b.maxX),Math.max(b.minZ-point.z,0,point.z-b.maxZ)):Infinity;
        view.visibility.setVisible(distance<=(view.visibility.isVisible()?view.unload:view.load),!point);
      }
      for(const view of bandViews){
        const b=view.bounds;
        const distance=point?Math.hypot(Math.max(b.minX-point.x,0,point.x-b.maxX),Math.max(view.minY-point.y,0,point.y-view.maxY),Math.max(b.minZ-point.z,0,point.z-b.maxZ)):Infinity;
        const limit=view.visibility?.isVisible()?view.unload:view.load;
        view.visibility?.setVisible(distance<=limit,!point);
      }
      for(const view of detailViews){
        const b=view.bounds;
        const distance=point?Math.hypot(Math.max(b.minX-point.x,0,point.x-b.maxX),Math.max(view.minY-point.y,0,point.y-view.maxY),Math.max(b.minZ-point.z,0,point.z-b.maxZ)):Infinity;
        view.visibility?.setVisible(distance<=32,!point);
      }
    });
    scope.onDispose(()=>core.scene.onBeforeRenderObservable.remove(detailObserver));
    const collision=cityCollision(city);
    const streetNames=new Map(city.roads.map(r=>[r.id,r.name||r.id]));
    const streetLights=Object.freeze(city.placements.filter(p=>p.templateId==='world/lamp').map(p=>Object.freeze({id:p.key,street:streetNames.get(p.key.split('/').slice(2,-2).join('/'))??p.key,x:p.position[0]+1.5*Math.cos(p.rotation[1]),y:p.position[1]+4.125,z:p.position[2]-1.5*Math.sin(p.rotation[1])})));
    return { bounds: city.bounds, objectCount: city.placements.length+city.chunks.reduce((n,c)=>n+c.meshes.length+(c.details??[]).reduce((n,d)=>n+d.meshes.length,0),0),
      collision,streetLights,
      regions: generated.map(region => ({ id: region.schemeId, bounds: region.bounds, objectCount:region.objectCount })),
      streaming: deps.streaming.getStats,
      visibility() {
        const lods = [0, 0, 0];
        let visibleStatic=0;for(const view of bandViews)if(view.meshes[0]?.isEnabled())visibleStatic+=view.count;
        let hidden = buildingCount - buildings.size-visibleStatic;
        for(const view of detailViews)if(view.meshes[0]?.isEnabled())lods[0]++;
        lods[2]=Math.max(0,visibleStatic-lods[0]);
        for (const building of buildings) {
          const level = building.level();
          if (level === null) hidden++; else lods[level]++;
        }
        const lampLods = [0, 0];
        let hiddenLamps = lampCount - lamps.size;
        for (const lamp of lamps) {
          const level = lamp.level();
          if (level === null) hiddenLamps++; else lampLods[level]++;
        }
        return { buildings: buildingCount, hidden, lods, lamps: lampCount, hiddenLamps, lampLods };
      },
    };
  },
  test: {
    durationSeconds: 10,
    setup({ core, deps, api, scope, report }) {
      const camera = core.scene.activeCamera;
      if (!(camera instanceof ArcRotateCamera)) throw new Error('Для обзора квартала нужна ArcRotateCamera');
      const upperRadius = camera.upperRadiusLimit;
      scope.onDispose(() => { camera.upperRadiusLimit = upperRadius; });
      camera.upperRadiusLimit = 500;
      camera.setTarget(new Vector3(api.collision.spawn.x,4,api.collision.spawn.z));
      let frames = 0;
      let hiddenMin = Infinity;
      let hiddenMax = 0;
      let hiddenLampsMin = Infinity;
      let hiddenLampsMax = 0;
      let detailedLampsMax = 0;
      let reducedLampsMax = 0;
      let lodCandidatesMin = Infinity;
      let lodCandidatesMax = 0;
      let boundsUpdatesMax = 0;
      let batchesMax = 0;
      let batchedInstancesMax = 0;
      let loadedSectionsMax = 0;
      const observer = core.scene.onAfterRenderObservable.add(() => {
        const visibility = api.visibility();
        hiddenMin = Math.min(hiddenMin, visibility.hidden);
        hiddenMax = Math.max(hiddenMax, visibility.hidden);
        hiddenLampsMin = Math.min(hiddenLampsMin, visibility.hiddenLamps);
        hiddenLampsMax = Math.max(hiddenLampsMax, visibility.hiddenLamps);
        detailedLampsMax = Math.max(detailedLampsMax, visibility.lampLods[0]);
        reducedLampsMax = Math.max(reducedLampsMax, visibility.lampLods[1]);
        const stats = deps.rendering.getStats();
        lodCandidatesMin = Math.min(lodCandidatesMin, stats.candidates);
        lodCandidatesMax = Math.max(lodCandidatesMax, stats.candidates);
        boundsUpdatesMax = Math.max(boundsUpdatesMax, stats.boundsUpdates);
        batchesMax = Math.max(batchesMax, stats.batches);
        batchedInstancesMax = Math.max(batchedInstancesMax, stats.batchedInstances);
        loadedSectionsMax = Math.max(loadedSectionsMax, api.streaming().loaded);
        frames++;
      });
      scope.onDispose(() => core.scene.onAfterRenderObservable.remove(observer));
      scope.onDispose(() => {
        if (frames) {
          const { buildings, lamps } = api.visibility();
          report({ objects: api.objectCount, buildings, sampledFrames: frames, hiddenMin, hiddenMax,
            hiddenFractionMin: hiddenMin / buildings, hiddenFractionMax: hiddenMax / buildings,
            lamps, hiddenLampsMin, hiddenLampsMax, detailedLampsMax, reducedLampsMax,
            lodCandidatesMin, lodCandidatesMax, boundsUpdatesMax, batchesMax, batchedInstancesMax, loadedSectionsMax, sectionLoads: api.streaming().loads, sectionUnloads: api.streaming().unloads });
        }
      });
      return progress => {
        const phase=progress*(reviewRoute.views.length-1);
        const index=Math.min(reviewRoute.views.length-2,Math.floor(phase));
        const from=reviewRoute.views[index],to=reviewRoute.views[index+1],t=phase-index;
        camera.setTarget(Vector3.Lerp(Vector3.FromArray(from.target),Vector3.FromArray(to.target),t));
        camera.setPosition(Vector3.Lerp(Vector3.FromArray(from.position),Vector3.FromArray(to.position),t));
      };
    },
  },
});
