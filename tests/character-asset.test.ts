import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Inspect exported glTF metadata without instantiating a Babylon scene or dumping its graph.
test('human asset stays within the render budget with one shared rig and baked locomotion clips', () => {
  const bytes=readFileSync(new URL('../scripts/character.glb',import.meta.url));
  assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);
  const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
  const manifest=JSON.parse(readFileSync(new URL('../public/models/human/manifest.json',import.meta.url),'utf8'));
  assert.ok(bytes.length<1400*1024);assert.ok(manifest.triangles<8000);assert.equal(manifest.primitives,1);
  assert.equal(manifest.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(gltf.meshes.length,1);assert.equal(gltf.meshes[0].primitives.length,1);assert.equal(gltf.materials.length,1);
  assert.equal(gltf.skins.length,1);assert.equal(gltf.skins[0].joints.length,65);
  assert.deepEqual(gltf.animations.map((a:{name:string})=>a.name).sort(),['Car_Enter','Car_Exit','Crawl_Fwd_Loop','Crawl_Idle_Loop','Crawl_Loop','Crouch_Fwd_Loop','Crouch_Idle_Loop','Driving_Loop','Fly_Boost_Loop','Fly_Idle_Loop','Fly_Loop','Idle_Loop','Jog_Fwd_Loop','Jump_Land','Jump_Loop','Jump_Start','Sprint_Loop','Swim_Fwd_Loop','Swim_Idle_Loop','Walk_Loop']);
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


test('skin geometry is closed under the shirt collar', async () => {
  const { NodeIO } = await import('@gltf-transform/core');
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
  const bytes = readFileSync(new URL('../scripts/character.glb', import.meta.url));
  const model = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(bytes);
  const primitive = model.getRoot().listMeshes()[0].listPrimitives()[0];
  const position = primitive.getAttribute('POSITION');
  const uv = primitive.getAttribute('TEXCOORD_0');
  const indices = primitive.getIndices()?.getArray();
  assert.ok(position && uv && indices);
  const key = (vertex: number) => {
    const [x, y, z] = position.getElement(vertex, [0, 0, 0]);
    const [u, v] = uv.getElement(vertex, [0, 0]);
    if (Math.abs(x) >= .15 || y <= 1.42 || y >= 1.56 || u < .5 || v < .5) return undefined;
    return [x, y, z].map(value => Math.round(value * 1e5)).join(',');
  };
  const edges = new Map<string, number>();
  for (let i = 0; i < indices.length; i += 3) {
    const triangle = [key(indices[i]), key(indices[i + 1]), key(indices[i + 2])];
    for (let side = 0; side < 3; side++) {
      const a = triangle[side], b = triangle[(side + 1) % 3];
      if (!a || !b || a === b) continue;
      const edge = [a, b].sort().join('/');
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
    }
  }
  assert.ok(edges.size > 100);
  assert.ok([...edges.values()].every(count => count === 2));
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
  assert.equal(selectAnimation({...s,moving:true,running:true}),'Jog_Fwd_Loop');
  assert.equal(selectAnimation({...s,moving:true,running:true,boosted:true}),'Sprint_Loop');
  assert.equal(selectAnimation({...s,mode:'fly',grounded:false}),'Fly_Idle_Loop');
  assert.equal(selectAnimation({...s,mode:'fly',grounded:false,moving:true}),'Fly_Loop');
  assert.equal(selectAnimation({...s,mode:'fly',grounded:false,moving:true,boosted:true}),'Fly_Boost_Loop');
  assert.equal(selectAnimation({...s,mode:'swim',grounded:false}),'Swim_Idle_Loop');
  assert.equal(selectAnimation({...s,mode:'swim',grounded:false,moving:true}),'Swim_Fwd_Loop');
  assert.equal(selectAnimation({...s,stance:'crouching'}),'Crouch_Idle_Loop');
  assert.equal(selectAnimation({...s,stance:'crouching',moving:true}),'Crouch_Fwd_Loop');
  assert.equal(selectAnimation({...s,stance:'prone'}),'Crawl_Idle_Loop');
  assert.equal(selectAnimation({...s,stance:'prone',moving:true}),'Crawl_Fwd_Loop');
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
  const d=await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(new URL('../scripts/character.glb',import.meta.url).pathname),root=d.getRoot();
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

test('animation visibility ignores distant and offscreen avatars without changing their simulation',async()=>{
 const {NullEngine}=await import('@babylonjs/core/Engines/nullEngine.js');const {Scene}=await import('@babylonjs/core/scene.js');const {FreeCamera}=await import('@babylonjs/core/Cameras/freeCamera.js');const {Vector3}=await import('@babylonjs/core/Maths/math.vector.js');const {createScope}=await import('../src/core/scope.ts');const {createCharacterAssets}=await import('../src/modules/characters/assets.ts');
 const engine=new NullEngine(),scene=new Scene(engine),owner=createScope();try{const camera=new FreeCamera('view',new Vector3(0,2,-10),scene);camera.setTarget(new Vector3(0,1,0));camera.getViewMatrix(true);scene.activeCamera=camera;const assets=createCharacterAssets(scene,owner);
  assert.equal(assets.shouldAnimate(0,0,0),true);assert.equal(assets.shouldAnimate(0,0,200),false);assert.equal(assets.shouldAnimate(0,0,-30),false);
  camera.setTarget(new Vector3(0,1,-40));camera.getViewMatrix(true);engine.endFrame();assert.equal(assets.shouldAnimate(0,0,-30),true);assert.equal(assets.shouldAnimate(0,0,20),false);await assets.ready;
 }finally{owner.dispose();scene.dispose();engine.dispose();}
});

test('starting a clip keeps the outgoing pose until the fade begins',async()=>{
  const {NullEngine}=await import('@babylonjs/core/Engines/nullEngine.js');
  const {Scene}=await import('@babylonjs/core/scene.js');
  const {AnimationGroup}=await import('@babylonjs/core/Animations/animationGroup.js');
  const {Animation}=await import('@babylonjs/core/Animations/animation.js');
  const {TransformNode}=await import('@babylonjs/core/Meshes/transformNode.js');
  const {blendAnimations,startAvatarClip}=await import('../src/modules/characters/assets.ts');
  const engine=new NullEngine(),scene=new Scene(engine);
  try {
    const target=new TransformNode('target',scene);
    const [walking,idle]=[2,10].map(value=>{
      const group=new AnimationGroup(String(value),scene);
      const clip=new Animation('pose','position.x',30,Animation.ANIMATIONTYPE_FLOAT);
      clip.setKeys([{frame:0,value},{frame:30,value:value+1}]);
      group.addTargetedAnimation(clip,target);
      return group;
    });
    startAvatarClip(walking,1);
    assert.equal(target.position.x,2);
    scene._animate(0);
    const before=target.position.x;
    startAvatarClip(idle,0);
    assert.equal(target.position.x,before);
    blendAnimations([walking,idle],idle,16);
    scene._animate(16);
    assert.ok(target.position.x>before&&target.position.x<10);
  } finally {scene.dispose();engine.dispose();}
});

test('ground animation ignores isolated steps and keeps the sprint clip during a brief blockage',async()=>{
  const {createGroundMotion}=await import('../src/modules/characters/assets.ts');
  const sample=createGroundMotion();
  const walk={moving:true,running:false,boosted:false},stop={...walk,moving:false};
  const frame=1000/60;
  sample(stop,0,0,true);
  for(let i=0;i<48;i++)assert.equal(sample(walk,i%8===0?1.8:.03,frame,false).moving,false);
  const sprint={moving:true,running:true,boosted:true};
  for(let i=0;i<8;i++)sample(sprint,22,frame,false);
  const blocked=sample(stop,0,frame,false);
  assert.equal(blocked.moving,true);
  assert.equal(blocked.boosted,true);
  for(let i=0;i<20;i++)sample(stop,0,frame,false);
  assert.equal(sample(stop,0,frame,false).moving,false);
});

test('walking off successive ledges never selects the rising jump pose',async()=>{
  const {selectAnimation}=await import('../src/modules/characters/assets.ts');
  const {createCharacterAuthority}=await import('../src/modules/characters/headless.ts');
  const world={bounds:{minX:-10,maxX:10,minZ:-10,maxZ:10},baseHeight:0,slopeX:0,
    spawn:{x:-.03,z:0},blockers:[],floors:[
      {minX:-2,maxX:0,minZ:-2,maxZ:2,elevation:.9},
      {minX:-2,maxX:1,minZ:-2,maxZ:2,elevation:.45},
    ]};
  const actor=createCharacterAuthority(world);
  let drops=0,wasGrounded=true;
  for(let tick=1;tick<=80;tick++){
    assert.ok(actor.receive({type:'move',characterId:'local-player',sequence:tick,tick:tick-1,x:1,z:0,run:false,jump:false},'local').accepted);
    actor.step(tick);
    const snapshot=actor.snapshot();
    if(!snapshot.grounded){
      if(wasGrounded){drops++;assert.equal(snapshot.airborneTicks,1);}
      assert.ok(snapshot.verticalSpeed<0);
      assert.equal(selectAnimation(snapshot),snapshot.airborneTicks<4?'Walk_Loop':'Jump_Loop');
    }
    wasGrounded=snapshot.grounded;
  }
  assert.equal(drops,2);
  const grounded=actor.snapshot();
  assert.equal(selectAnimation({...grounded,landedTick:grounded.tick,airborneTicks:2}),'Walk_Loop');
  assert.ok(actor.receive({type:'move',characterId:'local-player',sequence:81,tick:80,x:1,z:0,run:false,jump:true},'local').accepted);
  actor.step(81);
  assert.equal(selectAnimation(actor.snapshot()),'Jump_Start');
});

test('modular avatar swaps compatible parts and one rig while sharing geometry and palette materials',async t=>{
  const {NodeIO}=await import('@gltf-transform/core');
  const {ALL_EXTENSIONS}=await import('@gltf-transform/extensions');
  const {NullEngine}=await import('@babylonjs/core/Engines/nullEngine.js');
  const {Scene}=await import('@babylonjs/core/scene.js');
  const {PBRMaterial}=await import('@babylonjs/core/Materials/PBR/pbrMaterial.js');
  const {Texture}=await import('@babylonjs/core/Materials/Textures/texture.js');
  const {Observable}=await import('@babylonjs/core/Misc/observable.js');
  const {createScope}=await import('../src/core/scope.ts');
  const {createPanels}=await import('../src/core/panels.ts');
  const {defineModule}=await import('../src/core/context.ts');
  const {startModules}=await import('../src/core/modules.ts');
  const {geometryModule}=await import('../src/modules/geometry/index.ts');
  const {createAvatar,createCharacterAssets}=await import('../src/modules/characters/assets.ts');
  const {bodies,changeAppearance,defaultAppearance,npcAppearance}=await import('../src/modules/characters/appearance.ts');
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const sources=new Map<string,Uint8Array<ArrayBuffer>>();
  for(const body of ['male','female'] as const){
    const doc=await io.read(new URL(`../public/models/human/${body}.glb`,import.meta.url).pathname);
    const root=doc.getRoot();
    assert.equal(root.listSkins().length,1);
    assert.equal(root.listSkins()[0].listJoints().length,65);
    assert.equal(root.listAnimations().length,20);
    assert.ok(root.listAnimations().every(clip=>clip.listChannels().length<=80));
    assert.ok(bodies[body].hair.every(id=>root.listNodes().some(node=>node.getName()===`part-${id}`)));
    assert.ok(root.listTextures().some(texture=>texture.getName().endsWith('Normal')));
    for(const texture of root.listTextures())texture.dispose();
    sources.set(body,new Uint8Array(await io.writeBinary(doc)));
  }
  t.mock.method(globalThis,'fetch',async(url:string)=>{
    const body=url.split('/').at(-1)?.replace('.glb','')??'';
    return new Response(sources.get(body));
  });
  const engine=new NullEngine(),scene=new Scene(engine);
  const owner=createScope(),first=createScope(),second=createScope();
  let geometry:ReturnType<typeof geometryModule.setup>|undefined;
  const consumer=defineModule({id:'avatar-test',title:'',category:'Тесты',requires:{geometry:geometryModule},setup({deps}){
    geometry=deps.geometry;
    return {};
  }});
  const session=startModules([geometryModule,consumer],[consumer.id],{scene,onFrame:new Observable<number>(),panels:createPanels()});
  try{
    assert.ok(geometry);
    const assets=createCharacterAssets(scene,owner);
    await assets.ready;
    assert.deepEqual(assets.getStatus(),{state:'ready',error:null});
    const a=createAvatar(scene,geometry,assets,first);
    createAvatar(scene,geometry,assets,second);
    const roots=scene.transformNodes.filter(node=>node.name==='character/local-player');
    assert.equal(roots.length,2);
    const mesh=(index:number,name:string)=>roots[index].getChildMeshes().find(mesh=>mesh.name===`human/${name}`)!;
    assert.equal(mesh(0,'body').material,mesh(1,'body').material);
    const original=assets.getContainer('female')!.materials.find(material=>material.name==='skin');
    assert.ok(original instanceof PBRMaterial);
    const texture=new Texture(null,scene);
    owner.onDispose(()=>texture.dispose());
    original.albedoTexture=texture;
    const variant=assets.tinted(original,'#956044');
    assert.equal(variant.albedoTexture,texture);
    assert.equal(variant.transparencyMode,original.transparencyMode);
    assert.equal(variant.sideOrientation,original.sideOrientation);
    assert.equal(variant.backFaceCulling,original.backFaceCulling);
    assert.equal(variant.fillMode,original.fillMode);
    assert.equal(mesh(0,'body').geometry,mesh(1,'body').geometry);
    assert.equal(mesh(0,'part-SimpleParted').isEnabled(),true);
    assert.equal(mesh(0,'part-Beard').isEnabled(),false);
    assert.equal(mesh(0,'body').skeleton,mesh(0,'part-SimpleParted').skeleton);
    const previous=mesh(0,'body');
    a.setAppearance(changeAppearance(defaultAppearance,{body:'female',hair:'Buns',skin:3}));
    assert.ok(previous.isDisposed());
    assert.equal(mesh(0,'body').material,variant);
    assert.equal(roots[0].getChildMeshes().filter(mesh=>mesh.name==='human/body').length,1);
    assert.equal(mesh(0,'part-Buns').isEnabled(),true);
    assert.equal(mesh(0,'part-Long').isEnabled(),false);
    assert.notEqual(mesh(0,'body').material,mesh(1,'body').material);
    a.setFade(0);
    assert.equal(mesh(0,'part-Buns').isEnabled(),false);
    a.setFade(1);
    assert.equal(mesh(0,'part-Buns').isEnabled(),true);
    assert.equal(mesh(0,'part-Long').isEnabled(),false);
    assert.deepEqual(npcAppearance('street/1/crowd/2'),npcAppearance('street/1/crowd/2'));
    const variants=Array.from({length:80},(_,i)=>npcAppearance(`street/1/crowd/${i}`));
    assert.equal(new Set(variants.map(appearance=>appearance.body)).size,2);
    assert.ok(new Set(variants.map(appearance=>appearance.hair)).size>=5);
  }finally{second.dispose();first.dispose();owner.dispose();session.dispose();scene.dispose();engine.dispose();}
});

test('network gait measures interpolated movement between frames sharing a snapshot tick',async()=>{
  const {avatarHorizontalSpeed}=await import('../src/modules/characters/assets.ts');
  for(const metersPerSecond of [1.8,7]){
    const from={x:0,z:0,tick:120};
    const to={x:0,z:metersPerSecond/60,tick:120};
    assert.ok(Math.abs(avatarHorizontalSpeed(to,from,0,1000/60)-metersPerSecond)<1e-9);
    assert.equal(avatarHorizontalSpeed(to,from,metersPerSecond),metersPerSecond);
  }
});
