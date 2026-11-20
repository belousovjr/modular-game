import {Observable} from '@babylonjs/core/Misc/observable.js';
import {defineModule} from '../src/core/context.ts';
import {startModules} from '../src/core/modules.ts';
import {createPanels} from '../src/core/panels.ts';
import {createAvatar} from '../src/modules/characters/assets.ts';
import {createCharacterAuthority} from '../src/modules/characters/headless.ts';
import {geometryModule} from '../src/modules/geometry/index.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NullEngine} from '@babylonjs/core/Engines/nullEngine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {TransformNode} from '@babylonjs/core/Meshes/transformNode.js';
import {FreeCamera} from '@babylonjs/core/Cameras/freeCamera.js';
import {DirectionalLight} from '@babylonjs/core/Lights/directionalLight.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {MeshBuilder} from '@babylonjs/core/Meshes/meshBuilder.js';
import {createScope} from '../src/core/scope.ts';
import {createCharacterShadowSource} from '../src/modules/characters/shadow-proxy.ts';
import {createShadows} from '../src/modules/shadows/resources.ts';

test('character shadows share a low-poly rounded proxy, follow the avatar and stay outside camera layers',t=>{
  const engine=new NullEngine(),scene=new Scene(engine),owner=createScope(),views=createScope();
  t.after(()=>{views.dispose();owner.dispose();scene.dispose();engine.dispose();});
  const create=createCharacterShadowSource(scene,owner);
  const roots=Array.from({length:17},()=>new TransformNode('avatar',scene));
  const proxies=roots.map(root=>create(root,views));
  for(const proxy of proxies){
    assert.equal(proxy.layerMask,0);assert.equal(proxy.metadata.shadowNearOnly,true);assert.equal(proxy.metadata.shadowFeather,.87);assert.equal(proxy.isPickable,false);assert.equal(proxy.isEnabled(),true);
    assert.equal(proxy.geometry,proxies[0].geometry);assert.equal(proxy.material,proxies[0].material);
    assert.ok(proxy.getTotalIndices()/3<=48);assert.equal(proxy.skeleton,null);
    proxy.computeWorldMatrix(true);
    const box=proxy.getBoundingInfo().boundingBox;
    assert.ok(Math.abs(box.maximumWorld.x-box.minimumWorld.x-1.40)<1e-5);
    assert.ok(Math.abs(box.maximumWorld.y-box.minimumWorld.y-.60)<1e-5);
    assert.ok(Math.abs(box.maximumWorld.z-box.minimumWorld.z-1.36)<1e-5);
    assert.ok(Math.abs(box.minimumWorld.y+.02)<1e-5,'Shadow proxy must reach the feet');
  }
  roots[0].position.set(4,2,7);proxies[0].computeWorldMatrix(true);
  assert.ok(Math.abs(proxies[0].getAbsolutePosition().y-2.28)<1e-5);
  const camera=new FreeCamera('camera',new Vector3(0,2,-6),scene);scene.activeCamera=camera;
  const sun=new DirectionalLight('sun',new Vector3(.3,-1,.3),scene);
  const human=MeshBuilder.CreateBox('human',{},scene);human.metadata={shadowCaster:false};
  const shadowScope=createScope();
  const shadows=createShadows(scene,sun,()=>[human,...proxies],()=>({x:0,y:0,z:0}),shadowScope);
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(shadows.getStats().casters,17);
  assert.ok(sun.getShadowGenerator()?.getShadowMap()?.renderList?.includes(proxies[0]));
  const beforeFeatherChange=shadows.getStats().revision;
  proxies[0].metadata.shadowFeather=.4;
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.ok(shadows.getStats().revision>beforeFeatherChange);
  assert.equal(sun.getShadowGenerator()?.getShadowMap()?.renderList?.includes(human),false);
  shadowScope.dispose();human.dispose();views.dispose();roots.forEach(root=>root.dispose());owner.dispose();
  assert.equal(scene.geometries.length,0);assert.equal(scene.materials.length,0);
});

test('distance-limited avatars hide their model and shadow with hysteresis',t=>{
  const engine=new NullEngine(),scene=new Scene(engine),owner=createScope();
  t.after(()=>{owner.dispose();scene.dispose();engine.dispose();});
  engine.getDeltaTime=()=>16;
  const camera=new FreeCamera('camera',Vector3.Zero(),scene);
  const view:{render?:ReturnType<typeof createAvatar>}={};
  const probe=defineModule({id:'avatar-probe',title:'Avatar probe',category:'Тесты',requires:{geometry:geometryModule},
    setup({deps,scope}){
      view.render=createAvatar(scene,deps.geometry,{
        createShadowProxy:createCharacterShadowSource(scene,scope),
        ready:Promise.resolve(null),reportError:()=>{},shouldAnimate:()=>true,
        getContainer:()=>null,getStatus:()=>({state:'loading',error:null}),subscribe:()=>()=>{},
      },scope,{show:100,hide:110});
      return {};
    },
  });
  const session=startModules([geometryModule,probe],[probe.id],{scene,onFrame:new Observable<number>(),panels:createPanels()});
  owner.onDispose(()=>session.dispose());
  const {render}=view;
  assert.ok(render);
  const actor=createCharacterAuthority({bounds:{minX:-10,maxX:10,minZ:-10,maxZ:10},baseHeight:0,slopeX:0,
    spawn:{x:0,z:0},blockers:[],floors:[]}).snapshot();
  const npc={...actor,id:'npc/0'};
  render(npc);
  const root=scene.getTransformNodeByName('character/npc/0');
  assert.ok(root);
  const children=root.getChildMeshes();
  assert.equal(children.length,2);
  for(const [distance,visible] of [[110,true],[111,false],[105,false],[100,true]] as const){
    camera.position.y=distance;
    render(npc);
    assert.equal(root.isEnabled(),visible);
    assert.ok(children.every(mesh=>mesh.isEnabled()===visible));
  }
  camera.position.y=0;
  render({...npc,y:.2});
  assert.ok(root.position.y>0&&root.position.y<.2);
  camera.position.y=111;
  render(npc);
  camera.position.set(4,0,0);
  render({...npc,x:4,y:.1});
  assert.ok(root.isEnabled());
  assert.equal(root.position.x,4);
  assert.equal(root.position.y,.1);
  assert.deepEqual(root.getChildMeshes().map(mesh=>mesh.uniqueId),children.map(mesh=>mesh.uniqueId));
});
