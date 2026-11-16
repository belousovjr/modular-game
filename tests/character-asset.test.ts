import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Inspect exported glTF metadata without instantiating a Babylon scene or dumping its graph.
test('human asset stays within the render budget with one shared rig and baked locomotion clips', () => {
  const bytes=readFileSync(new URL('../public/models/human/character.glb',import.meta.url));
  assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);
  const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  const manifest=JSON.parse(readFileSync(new URL('../public/models/human/manifest.json',import.meta.url),'utf8'));
  assert.ok(bytes.length<1200*1024);assert.ok(manifest.triangles<8000);assert.equal(manifest.primitives,1);
  assert.equal(manifest.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(gltf.meshes.length,1);assert.equal(gltf.meshes[0].primitives.length,1);assert.equal(gltf.materials.length,1);
  assert.equal(gltf.skins.length,1);assert.equal(gltf.skins[0].joints.length,65);
  assert.deepEqual(gltf.animations.map((a:{name:string})=>a.name).sort(),['Idle_Loop','Jog_Fwd_Loop','Jump_Land','Jump_Loop','Jump_Start','Sprint_Loop','Walk_Loop']);
  assert.ok(gltf.animations.every((a:{channels:unknown[]})=>a.channels.length<=80),'Static bone tracks must stay pruned');
  const primitive=gltf.meshes[0].primitives[0];assert.ok('JOINTS_0'in primitive.attributes&&'WEIGHTS_0'in primitive.attributes);
  assert.equal(gltf.accessors[primitive.indices].count/3,manifest.triangles);
  const binaryStart=28+bytes.readUInt32LE(12);
  for(const animation of gltf.animations)for(const channel of animation.channels) {
    assert.ok(gltf.skins[0].joints.includes(channel.target.node));
    const accessor=gltf.accessors[animation.samplers[channel.sampler].output],view=gltf.bufferViews[accessor.bufferView];
    assert.equal(accessor.componentType,5126);
    const width=accessor.type==='VEC4'?4:3,stride=view.byteStride??width*4;
    for(let i=0;i<accessor.count;i++) {
      const values=Array.from({length:width},(_,k)=>bytes.readFloatLE(binaryStart+(view.byteOffset??0)+(accessor.byteOffset??0)+i*stride+k*4));
      assert.ok(values.every(Number.isFinite));
      if(width===4)assert.ok(Math.abs(Math.hypot(...values)-1)<.003,'Invalid retargeted quaternion');
      if(channel.target.path==='translation'&&gltf.nodes[channel.target.node].name==='root')assert.ok(Math.hypot(...values)<.0001,'Locomotion must remain in place');
    }
  }
  assert.ok(manifest.animationLibraries.every((l:{verifiedFreeClips:string[]})=>l.verifiedFreeClips.length>=40));
});


test('native animation weights crossfade without a pose snap and stop faded groups', async () => {
  const {NullEngine}=await import('@babylonjs/core/Engines/nullEngine.js');
  const {Scene}=await import('@babylonjs/core/scene.js');
  const {AnimationGroup}=await import('@babylonjs/core/Animations/animationGroup.js');
  const {Animation}=await import('@babylonjs/core/Animations/animation.js');
  const {TransformNode}=await import('@babylonjs/core/Meshes/transformNode.js');
  const {blendAnimations}=await import('../src/modules/characters/assets.ts');
  const engine=new NullEngine(),scene=new Scene(engine);
  try {
    const target=new TransformNode('target',scene);
    const groups=[0,1].map(i=>{const g=new AnimationGroup(String(i),scene);const a=new Animation('pose','position.x',30,Animation.ANIMATIONTYPE_FLOAT);a.setKeys([{frame:0,value:i},{frame:30,value:i+1}]);g.addTargetedAnimation(a,target);g.start(true);g.weight=1-i;return g;});
    blendAnimations(groups,groups[1],16);
    assert.ok(groups[1].weight>0&&groups[1].weight<.4);
    assert.ok(Math.abs(groups[0].weight+groups[1].weight-1)<1e-8);
    const before=groups[0].weight;
    blendAnimations(groups,groups[0],16);assert.ok(groups[0].weight>before&&groups[0].weight<1);
    for(let i=0;i<25;i++)blendAnimations(groups,groups[1],16);
    assert.ok(groups[1].weight>.99);assert.equal(groups[0].isPlaying,false);
  } finally {scene.dispose();engine.dispose();}
});


test('walking selects its own clip and visual turning follows the short arc independently of FPS', async () => {
  const {selectAnimation,smoothYaw}=await import('../src/modules/characters/assets.ts');
  const {createCharacterAuthority}=await import('../src/modules/characters/headless.ts');
  const s=createCharacterAuthority({bounds:{minX:-10,maxX:10,minZ:-10,maxZ:10},baseHeight:0,slopeX:0,spawn:{x:0,z:0},blockers:[],floors:[]}).snapshot();
  assert.equal(selectAnimation({...s,moving:true,running:false}),'Walk_Loop');
  assert.equal(selectAnimation({...s,moving:true,running:true}),'Sprint_Loop');
  assert.equal(selectAnimation(s),'Idle_Loop');
  assert.equal(selectAnimation({...s,grounded:false,airborneTicks:8,moving:true}),'Jump_Loop');
  const turned=smoothYaw(0,Math.PI/2,16);
  assert.ok(turned>0&&turned<Math.PI/2,'Direction must not snap');
  assert.ok(smoothYaw(Math.PI-.01,-Math.PI+.01,16)>Math.PI-.01,'Turn crossed the long arc');
  const advance=(fps:number)=>{let yaw=0;for(let i=0;i<fps;i++)yaw=smoothYaw(yaw,Math.PI/2,1000/fps);return yaw;};
  assert.ok(Math.abs(advance(30)-advance(144))<1e-8);
  assert.ok(Math.abs(smoothYaw(0,Math.PI/2,180)-Math.PI/2)<.08);
});
