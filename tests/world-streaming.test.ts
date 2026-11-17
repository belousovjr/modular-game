import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { Observable } from '@babylonjs/core/Misc/observable.js';
import { defineModule } from '../src/core/context.ts';
import { createScope } from '../src/core/scope.ts';
import { createPanels } from '../src/core/panels.ts';
import { startModules } from '../src/core/modules.ts';
import { geometryModule } from '../src/modules/geometry/index.ts';
import { objectTemplatesModule } from '../src/modules/object-templates/index.ts';
import { objectRenderingModule, type DistancePoint } from '../src/modules/object-rendering/index.ts';
import { worldStreamingModule } from '../src/modules/world-streaming/index.ts';

function fixture(t: { after(cleanup: () => void): void }) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  t.after(() => { scene.dispose(); engine.dispose(); });
  let api: { streaming: ReturnType<typeof worldStreamingModule.setup>; rendering: ReturnType<typeof objectRenderingModule.setup> } | undefined;
  const probe = defineModule({ id: 'probe', title: '', category: 'Тесты', requires: { streaming: worldStreamingModule, rendering: objectRenderingModule }, setup({ deps }) { api = deps; return {}; } });
  const session = startModules([geometryModule, objectTemplatesModule, objectRenderingModule, worldStreamingModule, probe], ['probe'], { scene, onFrame: new Observable<number>(), panels: createPanels() });
  t.after(() => session.dispose());
  assert.ok(api);
  const owner = createScope(); t.after(() => owner.dispose());
  let point: DistancePoint | null = { x: 0, y: 0, z: 0 };
  api.rendering.setDistanceSource(() => point, owner);
  return { ...api, owner, session,engine, frame: () => scene.onBeforeRenderObservable.notifyObservers(scene), move: (next: DistancePoint | null) => { point = next; } };
}

test('streaming bounds work across negative coordinates, budget loads, hysteresis, teleports and a missing origin', t => {
  const f = fixture(t);
  let active = 0;
  for (let i = 0; i < 4; i++) f.streaming.registerSection(`near/${i}`, { minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, owner => { active++; owner.onDispose(() => active--); }, f.owner);
  f.streaming.registerSection('far', { minX: 990, maxX: 1010, minZ: -10, maxZ: 10 }, owner => { active++; owner.onDispose(() => active--); }, f.owner);
  f.move({ x: -203, y: 0, z: 0 }); f.frame(); assert.equal(active, 0);
  f.move({ x: -202, y: 0, z: 0 });
  f.frame(); assert.equal(active, 2);
  f.frame(); assert.equal(active, 4);
  f.move({ x: -266, y: 0, z: 0 }); f.frame(); assert.equal(active, 4);
  f.move({ x: -267, y: 0, z: 0 }); f.frame(); assert.equal(active, 0);
  f.move({ x: 1000, y: 0, z: 0 }); f.frame(); assert.equal(active, 1);
  f.move(null); f.frame(); assert.equal(active, 0);
  f.move({ x: 0, y: 0, z: 0 }); f.frame(); f.frame(); assert.equal(active, 4);
  f.owner.dispose(); assert.equal(active, 0);
  assert.equal(f.streaming.getStats().sections, 0);
  f.session.dispose();
  assert.throws(() => f.streaming.getStats(), /остановлена/);
});

test('streaming validates registrations and rolls back a partially failed load', t => {
  const f = fixture(t);
  const b = { minX: 0, maxX: 10, minZ: 0, maxZ: 10 };
  let active = 0;
  assert.throws(() => f.streaming.registerSection('bad', { ...b, maxX: Infinity }, () => {}, f.owner), /участок/);
  f.streaming.registerSection('broken', b, owner => {
    active++; owner.onDispose(() => active--);
    throw new Error('load failure');
  }, f.owner);
  assert.throws(() => f.streaming.registerSection('broken', b, () => {}, f.owner), /участок/);
  assert.throws(f.frame, /load failure/);
  assert.equal(active, 0);
  assert.equal(f.streaming.getStats().loaded, 0);
});

test('skyline sections can stream farther while street sections retain their normal budget',t=>{
  const f=fixture(t),bounds={minX:990,maxX:1010,minZ:-10,maxZ:10};let streets=0,skyline=0;
  f.streaming.registerSection('street',bounds,o=>{streets++;o.onDispose(()=>streets--);},f.owner);
  f.streaming.registerSection('skyline',bounds,o=>{skyline++;o.onDispose(()=>skyline--);},f.owner,{load:1200,unload:1400});
  f.frame();assert.equal(streets,0);assert.equal(skyline,1);
  f.move({x:-500,y:0,z:0});f.frame();assert.equal(skyline,0);
  assert.throws(()=>f.streaming.registerSection('bad',bounds,()=>{},f.owner,{load:1200,unload:1000}),/distances/);
});


test('optional unload grace retains a fading section, cancels on return and clears immediately without an origin',t=>{
  const f=fixture(t);f.engine.getDeltaTime=()=>25;let active=0;
  f.streaming.registerSection('fade',{minX:0,maxX:10,minZ:0,maxZ:10},owner=>{active++;owner.onDispose(()=>active--);},f.owner,{load:10,unload:20,unloadDelayMs:100});
  f.frame();assert.equal(active,1);f.move({x:50,y:0,z:0});f.frame();f.frame();assert.equal(active,1);
  f.move({x:0,y:0,z:0});f.frame();f.move({x:50,y:0,z:0});f.frame();for(let i=0;i<3;i++)f.frame();assert.equal(active,1);f.frame();assert.equal(active,0);
  f.move({x:0,y:0,z:0});f.frame();f.move(null);f.frame();assert.equal(active,0);
  assert.throws(()=>f.streaming.registerSection('invalid',{minX:0,maxX:10,minZ:0,maxZ:10},()=>{},f.owner,{load:10,unload:20,unloadDelayMs:Infinity}));
});
