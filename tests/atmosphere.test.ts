import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {RawTexture} from '@babylonjs/core/Materials/Textures/rawTexture.js';
import {NightField} from '../src/modules/materials/night-field.ts';
import {NullEngine} from '@babylonjs/core/Engines/nullEngine.js';import {Scene} from '@babylonjs/core/scene.js';import {Observable} from '@babylonjs/core/Misc/observable.js';import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {defineModule} from '../src/core/context.ts';import {startModules} from '../src/core/modules.ts';import {createPanels} from '../src/core/panels.ts';import {createScope} from '../src/core/scope.ts';import {geometryModule} from '../src/modules/geometry/index.ts';import {createLighting} from '../src/modules/lighting/light.ts';import {createMaterials} from '../src/modules/materials/resources.ts';import {CityFacade} from '../src/modules/materials/city-surface.ts';import {atmosphereColors,createAtmosphere} from '../src/modules/atmosphere/resources.ts';

test('atmosphere cycles locally, changes shared night materials and restores resources and scene state',()=>{
 const engine=new NullEngine(),scene=new Scene(engine),onFrame=new Observable<number>(),core={scene,onFrame,panels:createPanels()};
 const probe=defineModule({id:'atmosphere-test',title:'',category:'Тесты',requires:{geometry:geometryModule},setup({deps,scope}){
  const lighting=createLighting(scene,scope),materials=createMaterials(scene,deps.geometry,scope);
  const original={mode:scene.fogMode,density:scene.fogDensity,color:scene.fogColor.clone(),clear:scene.clearColor.clone()},counts={meshes:scene.meshes.length,materials:scene.materials.length,textures:scene.textures.length};
  const city=deps.geometry.getSurfaceMaterial('city-stone');assert.ok(city instanceof StandardMaterial);const facade=city.pluginManager?.getPlugin('CityFacade');assert.ok(facade instanceof CityFacade);
  const map=RawTexture.CreateRGBATexture(new Uint8Array([255,0,0,255]),1,1,scene,false);scope.onDispose(()=>map.dispose());
  const ownerField=createScope(),field=materials.registerNightField(map,{minX:-1,minZ:-1,maxX:1,maxZ:1},ownerField);
  const road=deps.geometry.getSurfaceMaterial('road');assert.ok(road instanceof StandardMaterial);assert.ok(road.pluginManager?.getPlugin('NightField') instanceof NightField);
  const foundation=deps.geometry.getSurfaceMaterial('foundation');assert.ok(!(foundation.pluginManager?.getPlugin('NightField') instanceof NightField));
  field.setNight(1);assert.ok(road.getActiveTextures().includes(map));assert.throws(()=>field.setNight(NaN));assert.throws(()=>materials.registerNightField(map,{minX:-1,minZ:-1,maxX:1,maxZ:1},ownerField));
  ownerField.dispose();assert.ok(!road.getActiveTextures().includes(map));assert.throws(()=>field.setNight(1));map.dispose();
  for(let repeat=0;repeat<3;repeat++){
   const owner=createScope(),api=createAtmosphere(scene,lighting,materials,onFrame,owner);assert.equal(scene.meshes.length,counts.meshes+1);assert.equal(scene.lights.length,2);assert.equal(scene.textures.length,counts.textures+1);
   api.setPlaying(false);lighting.setSettings({hour:0});assert.equal(facade.night,1);const nightFog=scene.fogColor.clone();lighting.setSettings({hour:12});assert.equal(facade.night,0);assert.ok(Math.hypot(...scene.fogColor.subtract(nightFog).asArray())>.1);
   onFrame.notifyObservers(1000);assert.equal(lighting.getSettings().hour,12);api.setPlaying(true);onFrame.notifyObservers(60000);assert.ok(Math.abs(lighting.getSettings().hour-13.2)<1e-8);
   const before:number=facade.night;assert.throws(()=>materials.setNightFactor(NaN));assert.equal(facade.night,before);
   owner.dispose();assert.equal(scene.fogMode,original.mode);assert.equal(scene.fogDensity,original.density);assert.ok(scene.fogColor.equals(original.color));assert.ok(scene.clearColor.equals(original.clear));assert.equal(facade.night,0);
   assert.equal(scene.meshes.length,counts.meshes);assert.equal(scene.materials.length,counts.materials);assert.equal(scene.textures.length,counts.textures);assert.throws(()=>api.setPlaying(true));assert.throws(()=>api.subscribe(()=>{}));
  }
  return {};
 }});
 const session=startModules([geometryModule,probe],['atmosphere-test'],core);session.dispose();scene.dispose();engine.dispose();
});

test('atmosphere colours remain continuous at midnight and local texture assets stay bounded and verifiable',()=>{
 const midnight=atmosphereColors(0),almost=atmosphereColors(23.999);assert.ok(Math.hypot(...midnight.horizon.subtract(almost.horizon).asArray())<.001);assert.equal(atmosphereColors(12).night,0);assert.equal(midnight.night,1);assert.throws(()=>atmosphereColors(NaN));
 const manifest=JSON.parse(readFileSync('public/textures/atmosphere/manifest.json','utf8'));let bytes=0;
 for(const [file,entry]of Object.entries<{bytes:number;sha256:string}>(manifest.files)){const buffer=readFileSync('public/textures/atmosphere/'+file);bytes+=buffer.length;assert.equal(createHash('sha256').update(buffer).digest('hex'),entry.sha256);assert.equal(buffer.length,entry.bytes);}
 assert.ok(bytes<40000);assert.deepEqual(Object.keys(manifest.files),['moon.webp']);
});
