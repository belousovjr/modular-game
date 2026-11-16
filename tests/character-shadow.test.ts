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

test('character shadows share a low-poly capsule, follow the avatar and stay outside camera layers',t=>{
  const engine=new NullEngine(),scene=new Scene(engine),owner=createScope(),views=createScope();
  t.after(()=>{views.dispose();owner.dispose();scene.dispose();engine.dispose();});
  const create=createCharacterShadowSource(scene,owner);
  const roots=Array.from({length:17},()=>new TransformNode('avatar',scene));
  const proxies=roots.map(root=>create(root,views));
  for(const proxy of proxies){
    assert.equal(proxy.layerMask,0);assert.equal(proxy.isPickable,false);assert.equal(proxy.isEnabled(),true);
    assert.equal(proxy.geometry,proxies[0].geometry);assert.equal(proxy.material,proxies[0].material);
    assert.ok(proxy.getTotalIndices()/3<=128);assert.equal(proxy.skeleton,null);
    proxy.computeWorldMatrix(true);
    const box=proxy.getBoundingInfo().boundingBox;
    assert.ok(Math.abs(box.maximumWorld.x-box.minimumWorld.x-.72)<1e-5);
    assert.ok(Math.abs(box.maximumWorld.y-box.minimumWorld.y-1.05)<1e-5);
    assert.ok(Math.abs(box.maximumWorld.z-box.minimumWorld.z-.576)<1e-5);
    assert.ok(Math.abs(box.minimumWorld.y)<1e-5,'Shadow proxy must reach the feet');
  }
  roots[0].position.set(4,2,7);proxies[0].computeWorldMatrix(true);
  assert.ok(Math.abs(proxies[0].getAbsolutePosition().y-2.525)<1e-5);
  const camera=new FreeCamera('camera',new Vector3(0,2,-6),scene);scene.activeCamera=camera;
  const sun=new DirectionalLight('sun',new Vector3(.3,-1,.3),scene);
  const human=MeshBuilder.CreateBox('human',{},scene);human.metadata={shadowCaster:false};
  const shadowScope=createScope();
  const shadows=createShadows(scene,sun,()=>[human,...proxies],()=>({x:0,y:0,z:0}),shadowScope);
  scene.onBeforeRenderObservable.notifyObservers(scene);
  assert.equal(shadows.getStats().casters,17);
  assert.ok(sun.getShadowGenerator()?.getShadowMap()?.renderList?.includes(proxies[0]));
  assert.equal(sun.getShadowGenerator()?.getShadowMap()?.renderList?.includes(human),false);
  shadowScope.dispose();human.dispose();views.dispose();roots.forEach(root=>root.dispose());owner.dispose();
  assert.equal(scene.geometries.length,0);assert.equal(scene.materials.length,0);
});
