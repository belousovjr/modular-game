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
  assert.ok(bytes.length<1400*1024);assert.ok(manifest.triangles<8000);assert.equal(manifest.primitives,1);
  assert.equal(manifest.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(gltf.meshes.length,1);assert.equal(gltf.meshes[0].primitives.length,1);assert.equal(gltf.materials.length,1);
  assert.equal(gltf.skins.length,1);assert.equal(gltf.skins[0].joints.length,65);
  assert.deepEqual(gltf.animations.map((a:{name:string})=>a.name).sort(),['Car_Enter','Car_Exit','Crawl_Loop','Driving_Loop','Idle_Loop','Jog_Fwd_Loop','Jump_Land','Jump_Loop','Jump_Start','Sprint_Loop','Walk_Loop']);
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
  assert.equal(selectAnimation({...s,vehicleId:'car/0',vehicleAnimation:'crawling'}),'Crawl_Loop');
  assert.equal(selectAnimation({...s,grounded:false,airborneTicks:8,moving:true}),'Jump_Loop');
  const turned=smoothYaw(0,Math.PI/2,16);
  assert.ok(turned>0&&turned<Math.PI/2,'Direction must not snap');
  assert.ok(smoothYaw(Math.PI-.01,-Math.PI+.01,16)>Math.PI-.01,'Turn crossed the long arc');
  const advance=(fps:number)=>{let yaw=0;for(let i=0;i<fps;i++)yaw=smoothYaw(yaw,Math.PI/2,1000/fps);return yaw;};
  assert.ok(Math.abs(advance(30)-advance(144))<1e-8);
  assert.ok(Math.abs(smoothYaw(0,Math.PI/2,180)-Math.PI/2)<.08);
});

// Verify the baked asset in world space, independently of the retargeter's FBX helper handling.
test('car-specific Mixamo clips keep feet below the head and meet the driving seat at their endpoints',async()=>{
  const {NodeIO}=await import('@gltf-transform/core');
  const {ALL_EXTENSIONS}=await import('@gltf-transform/extensions');
  const {Quaternion}=await import('@babylonjs/core/Maths/math.vector.js');
  const d=await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(new URL('../public/models/human/character.glb',import.meta.url).pathname),root=d.getRoot();
  const nodes=root.listNodes(),saved=nodes.map(n=>({n,t:n.getTranslation(),q:n.getRotation()}));
  const node=(name:string)=>{const n=nodes.find(n=>n.getName()===name);assert.ok(n);return n;};
  const pose=(name:string,fraction:number)=>{
    for(const {n,t,q}of saved)n.setTranslation(t).setRotation(q);
    const animation=root.listAnimations().find(a=>a.getName()===name);assert.ok(animation);
    const duration=Math.max(...animation.listSamplers().map(s=>s.getInput()!.getMax([])[0]));
    for(const c of animation.listChannels()){
      const sampler=c.getSampler()!,times=sampler.getInput()!,values=sampler.getOutput()!,time=duration*fraction;let k=0;
      while(k+1<times.getCount()&&times.getScalar(k+1)<=time)k++;
      const j=Math.min(k+1,times.getCount()-1),alpha=k===j?0:(time-times.getScalar(k))/(times.getScalar(j)-times.getScalar(k)),a=values.getElement(k,[]),b=values.getElement(j,[]);
      if(c.getTargetPath()==='rotation')c.getTargetNode()!.setRotation(Quaternion.Slerp(Quaternion.FromArray(a),Quaternion.FromArray(b),alpha).asArray());
      if(c.getTargetPath()==='translation')c.getTargetNode()!.setTranslation([a[0]+(b[0]-a[0])*alpha,a[1]+(b[1]-a[1])*alpha,a[2]+(b[2]-a[2])*alpha]);
    }
    return {hip:node('pelvis').getWorldTranslation()[1],head:node('Head').getWorldTranslation()[1],feet:['foot_l','foot_r'].map(n=>node(n).getWorldTranslation()[1]),rotations:nodes.map(n=>n.getRotation())};
  };
  for(const t of [0,.25,.5,.75,1]){const crawl=pose('Crawl_Loop',t);assert.ok(crawl.head>.3&&crawl.head<.8,'Crawl must stay near the ground');assert.ok(Math.min(...crawl.feet)>0);}
  const seated=pose('Driving_Loop',0),standing=pose('Idle_Loop',0);
  for(const clip of ['Car_Enter','Car_Exit'])for(const t of [0,.25,.5,.75,1]){
    const p=pose(clip,t);assert.ok(p.head>Math.max(...p.feet)+.35,'Retargeted legs flipped above the torso');assert.ok(p.head<2&&p.hip>.3&&p.hip<1.1);
  }
  const entryEnd=pose('Car_Enter',1);
  assert.ok(Math.abs(entryEnd.hip-seated.hip)<.02);
  for(let i=0;i<entryEnd.rotations.length;i++)assert.ok(Math.abs(Quaternion.Dot(Quaternion.FromArray(entryEnd.rotations[i]),Quaternion.FromArray(seated.rotations[i])))>.99999,'Entry end must match the driving pose: '+nodes[i].getName());
  for(const t of [.88,.92,.96,1])assert.ok(pose('Car_Enter',t).head<seated.head+.03,'Late entry raised the head above the driving pose');
  assert.ok(Math.abs(pose('Car_Exit',0).hip-seated.hip)<.02);
  assert.ok(Math.abs(pose('Car_Enter',0).hip-standing.hip)<.05);
  assert.ok(Math.abs(pose('Car_Exit',1).hip-standing.hip)<.05);
});

test('visual orientation blends every direction and vehicle tilt without an instantaneous turn',async()=>{
  const {Quaternion}=await import('@babylonjs/core/Maths/math.vector.js');
  const {smoothCharacterRotation}=await import('../src/modules/characters/assets.ts');
  for(const target of [Quaternion.FromEulerAngles(0,Math.PI,0),Quaternion.FromEulerAngles(.3,-1.2,.4),Quaternion.Identity()]){
    const current=Quaternion.FromEulerAngles(.1,1.1,.2),before=current.clone();smoothCharacterRotation(current,target,16,current);
    assert.ok(Math.abs(Quaternion.Dot(current,before))>.95,'Transition snapped away from the previous orientation');
    assert.ok(Math.abs(Quaternion.Dot(current,target))<.999,'Transition snapped directly to the target');
    for(let i=0;i<30;i++)smoothCharacterRotation(current,target,16,current);
    assert.ok(Math.abs(Quaternion.Dot(current,target))>.9999);
  }
  const advance=(fps:number)=>{const q=Quaternion.Identity(),target=Quaternion.FromEulerAngles(.3,2,.4);for(let i=0;i<fps;i++)smoothCharacterRotation(q,target,1000/fps,q);return q;};
  assert.ok(Math.abs(Quaternion.Dot(advance(30),advance(144)))>1-1e-10);
});

test('completed action keeps its final pose available for an ordinary animation crossfade',async()=>{
  const {NullEngine}=await import('@babylonjs/core/Engines/nullEngine.js');const {Scene}=await import('@babylonjs/core/scene.js');
  const {AnimationGroup}=await import('@babylonjs/core/Animations/animationGroup.js');const {Animation}=await import('@babylonjs/core/Animations/animation.js');
  const {TransformNode}=await import('@babylonjs/core/Meshes/transformNode.js');const {blendAnimations}=await import('../src/modules/characters/assets.ts');
  const engine=new NullEngine(),scene=new Scene(engine);try{
    const target=new TransformNode('pose',scene),action=new AnimationGroup('action',scene),idle=new AnimationGroup('idle',scene);
    for(const [g,value]of [[action,1],[idle,0]] as const){const a=new Animation('pose','position.x',30,Animation.ANIMATIONTYPE_FLOAT,Animation.ANIMATIONLOOPMODE_CONSTANT);a.setKeys([{frame:0,value:0},{frame:30,value}]);g.addTargetedAnimation(a,target);}
    action.start(true);action.weight=1;scene._animate(0);scene._animate(1100);scene._animate(1100);
    assert.equal(action.isPlaying,true);assert.ok(Math.abs(target.position.x-1)<.001,'Completed action lost its final pose');
    idle.start(true);idle.weight=0;blendAnimations([action,idle],idle,16);scene._animate(16);
    assert.ok(action.weight>0&&action.weight<1);assert.ok(target.position.x>0&&target.position.x<1);
  }finally{scene.dispose();engine.dispose();}
});
