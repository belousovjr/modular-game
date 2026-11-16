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
import reviewRoute from './data/downtown/review-route.json' with {type:'json'};
import district from './data/downtown/district.json' with {type:'json'};
import {cityCollision} from './headless.ts';
import {geometryModule} from '../geometry/index.ts';
import {createElement} from 'react';
import {Link} from '@radix-ui/themes';
export type { CollisionWorld, CollisionBox } from './headless.ts';

export const worldModule = defineModule({
  id: 'world', title: 'Центр Чикаго', category: 'Окружение',
  requires: { generator: worldGenerationModule, geometry:geometryModule, templates: objectTemplatesModule, rendering: objectRenderingModule, streaming: worldStreamingModule },
  setup({ core, deps, scope }) {
    const city=deps.generator.generateCity(citySource);
    scope.onDispose(core.panels.register('world','Центр Чикаго',createElement(Link,{href:'https://www.openstreetmap.org/copyright',target:'_blank',rel:'noreferrer'},'© OpenStreetMap contributors · ODbL · Рельеф USGS 3DEP')));
    const generated=city.chunks.map(c=>({schemeId:c.id,bounds:c.bounds,objectCount:c.meshes.length+(c.details??[]).reduce((n,d)=>n+d.meshes.length,0)+city.placements.filter(p=>p.position[0]>=c.bounds.minX&&p.position[0]<c.bounds.maxX&&p.position[2]>=c.bounds.minZ&&p.position[2]<c.bounds.maxZ).length}));
    for(const template of cityTemplates)deps.templates.register(toCityGrid(template),scope);
    for (const template of worldTemplates) deps.templates.register(template.id==='world/lamp'?toCityGrid(template):template, scope);
    const buildings = new Set<ReturnType<typeof deps.rendering.createObject>>();
    const lamps: typeof buildings = new Set();
    const placements = city.placements.filter(p=>p.templateId!=='city/stone'&&p.templateId!=='city/glass');
    const buildingCount=city.colliders.length;
    const lampCount = placements.filter(p => p.templateId === 'city/signal' || p.templateId === 'world/lamp').length;
    const sections = new Map<string, { bounds: SectionBounds; placements: typeof placements }>();
    for (const placement of placements) {
      const [x, , z] = placement.position;
      const key = placement.templateId === 'world/terrain' ? placement.key : `${Math.floor(x / 128)}/${Math.floor(z / 128)}`;
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
          const object = deps.rendering.createObject(placement.templateId, placement.key, placement.parameters, owner, 'static', batchMaterial);
          object.root.position.copyFromFloats(...placement.position);
          object.root.rotation.copyFromFloats(...placement.rotation);
          const list = placement.templateId === 'city/signal' || placement.templateId === 'world/lamp' ? lamps : buildings;
          if (list) { list.add(object); owner.onDispose(() => list.delete(object)); }
        }
      }, scope,section.placements.some(p=>p.templateId!=='city/signal'&&p.templateId!=='world/lamp')?{load:1200,unload:1400}:{load:192,unload:256});
    }
    const bandViews=new Set<{meshes:Mesh[];bounds:SectionBounds;minY:number;maxY:number;count:number;load:number;unload:number}>();
    const heights=new Map(city.placements.map(p=>[p.key,p.parameters.height]));
    const bands=[{id:'surfaces',minHeight:0,maxHeight:0,load:192,unload:256},...district.buildingLod];
    for(const chunk of city.chunks)for(const band of bands) {
      const distant=band.id!=='surfaces';
      const surfaces=chunk.meshes.filter(m=>distant?m.surface.startsWith('city-')&&m.surface.endsWith('-'+band.id):!m.surface.startsWith('city-'));
      if(!surfaces.length)continue;
      const bounds=distant?{minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity}:{...chunk.bounds};
      let minY=Infinity,maxY=-Infinity;
      for(const surface of surfaces)for(let i=0;i<surface.positions.length;i+=3){bounds.minX=Math.min(bounds.minX,surface.positions[i]);bounds.maxX=Math.max(bounds.maxX,surface.positions[i]);bounds.minZ=Math.min(bounds.minZ,surface.positions[i+2]);bounds.maxZ=Math.max(bounds.maxZ,surface.positions[i+2]);minY=Math.min(minY,surface.positions[i+1]);maxY=Math.max(maxY,surface.positions[i+1]);}
      const count=distant?chunk.buildingIds.filter(id=>{const h=heights.get(id);return h!==undefined&&h>=band.minHeight&&h<band.maxHeight;}).length:0;
      deps.streaming.registerSection(`${chunk.id}/${distant?'buildings-':''}${band.id}`,bounds,owner=>{
        const meshes:Mesh[]=[];
        const view={meshes,bounds,minY,maxY,count,load:band.load,unload:band.unload};
        if(distant){bandViews.add(view);owner.onDispose(()=>bandViews.delete(view));}
        for(const surface of surfaces) {
          const material=distant?surface.surface.slice(0,-band.id.length-1):surface.surface;
          const mesh=deps.geometry.createSurfaceMesh(`${chunk.id}/${surface.surface}`,material,surface.positions,surface.indices,owner,surface.uvs);
          mesh.metadata={...mesh.metadata,citySurface:material,buildingBand:distant?band.id:undefined,shadowCaster:distant||['bank','facade','foundation','metal','roof'].includes(material)};mesh.freezeWorldMatrix();view.meshes.push(mesh);
        }
      },scope,{load:band.load,unload:band.unload});
    }
    const detailViews=new Set<{meshes:Mesh[];bounds:SectionBounds;minY:number;maxY:number}>();
    for(const chunk of city.chunks)for(const detail of chunk.details??[]) {
      deps.streaming.registerSection(detail.id,detail.bounds,owner=>{
        const meshes:Mesh[]=[];
        const view={meshes,bounds:detail.bounds,minY:Infinity,maxY:-Infinity};
        detailViews.add(view);owner.onDispose(()=>detailViews.delete(view));
        for(const surface of detail.meshes){
          const material=surface.surface.replace(/-detail$/,'');
          const mesh=deps.geometry.createSurfaceMesh(`${detail.id}/${material}`,material,surface.positions,surface.indices,owner,surface.uvs);
          mesh.metadata={...mesh.metadata,citySurface:material,buildingDetail:true,shadowNearOnly:true,shadowCaster:true};mesh.freezeWorldMatrix();
          view.meshes.push(mesh);
          for(let i=1;i<surface.positions.length;i+=3){view.minY=Math.min(view.minY,surface.positions[i]);view.maxY=Math.max(view.maxY,surface.positions[i]);}
        }
      },scope,{load:24,unload:32});
    }
    const detailObserver=core.scene.onBeforeRenderObservable.add(()=>{
      const point=deps.rendering.getDistanceOrigin();
      for(const view of bandViews){
        const b=view.bounds;
        const distance=point?Math.hypot(Math.max(b.minX-point.x,0,point.x-b.maxX),Math.max(view.minY-point.y,0,point.y-view.maxY),Math.max(b.minZ-point.z,0,point.z-b.maxZ)):Infinity;
        const limit=view.meshes[0]?.isEnabled()?view.unload:view.load;
        for(const mesh of view.meshes)mesh.setEnabled(distance<=limit);
      }
      for(const view of detailViews){
        const b=view.bounds;
        const distance=point?Math.hypot(Math.max(b.minX-point.x,0,point.x-b.maxX),Math.max(view.minY-point.y,0,point.y-view.maxY),Math.max(b.minZ-point.z,0,point.z-b.maxZ)):Infinity;
        for(const mesh of view.meshes)mesh.setEnabled(distance<=32);
      }
    });
    scope.onDispose(()=>core.scene.onBeforeRenderObservable.remove(detailObserver));
    const collision=cityCollision(city);
    return { bounds: city.bounds, objectCount: city.placements.length+city.chunks.reduce((n,c)=>n+c.meshes.length+(c.details??[]).reduce((n,d)=>n+d.meshes.length,0),0),
      collision,
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
