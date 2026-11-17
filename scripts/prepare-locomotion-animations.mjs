import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {Accessor,NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {dedup,prune,resample} from '@gltf-transform/functions';
import sharp from 'sharp';
import {Matrix,Quaternion,Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {retargetClips} from './retarget-character.mjs';

const source=process.argv[2];
const postureSource=process.argv[3];
if(!source||!postureSource)throw new Error('Usage: node scripts/prepare-locomotion-animations.mjs <Quaternius UAL1_Standard.glb> <Quaternius UAL1.glb>');
const file='public/models/human/character.glb';
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
const [model,library,postureLibrary]=await Promise.all([io.read(file),io.read(source),io.read(postureSource)]);
const root=model.getRoot(),buffer=root.listBuffers()[0],skin=root.listSkins()[0];
const swim=['Swim_Fwd_Loop','Swim_Idle_Loop'];
const flight=['Fly_Idle_Loop','Fly_Loop','Fly_Boost_Loop'];
const posture=['Crouch_Fwd_Loop','Crouch_Idle_Loop','Crawl_Fwd_Loop','Crawl_Idle_Loop'];
for(const clip of root.listAnimations())if([...swim,...flight,...posture].includes(clip.getName()))clip.dispose();
retargetClips(model,library,swim);
retargetClips(model,postureLibrary,posture);

const joints=skin.listJoints();
const idle=root.listAnimations().find(clip=>clip.getName()==='Idle_Loop');
assert.ok(idle);
const idleRotations=new Map(idle.listChannels().filter(c=>c.getTargetPath()==='rotation')
  .map(c=>[c.getTargetNode(),Quaternion.FromArray(c.getSampler().getOutput().getElement(0,[]))]));
const parentBind=new Map(joints.map((node,index)=>[node,Matrix.FromArray(skin.getInverseBindMatrices().getElement(index,[])).invert()]));
function track(clip,node,path,time,values){
  const output=model.createAccessor().setBuffer(buffer).setType(path==='rotation'?Accessor.Type.VEC4:Accessor.Type.VEC3).setArray(Float32Array.from(values));
  const sampler=model.createAnimationSampler().setInput(time).setOutput(output).setInterpolation('LINEAR');
  clip.addSampler(sampler).addChannel(model.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
}
for(const [variant,name] of flight.entries()){
  const clip=model.createAnimation(name);
  const duration=[2.2,1.5,1.1][variant];
  const time=model.createAccessor().setBuffer(buffer).setType(Accessor.Type.SCALAR)
    .setArray(Float32Array.from({length:9},(_,i)=>i*duration/8));
  for(const node of joints){
    const bone=node.getName(),base=idleRotations.get(node)??Quaternion.FromArray(node.getRotation());
    const matrix=parentBind.get(node.getParentNode());
    const basis=Quaternion.Identity();
    matrix?.decompose(undefined,basis);
    const values=[];
    for(let i=0;i<=8;i++){
      const phase=i*2*Math.PI/8,wind=Math.sin(phase),side=bone.endsWith('_l')?1:-1;
      let pitch=0,roll=0;
      if(bone.startsWith('upperarm_')){pitch=[-.10,-.40,-.63][variant]+wind*.055;roll=side*[.17,.28,.10][variant];}
      else if(bone.startsWith('lowerarm_'))pitch=[.18,.11,-.07][variant];
      else if(bone.startsWith('thigh_'))pitch=[-.16,.11,.22][variant]+side*wind*.065;
      else if(bone.startsWith('calf_'))pitch=[.29,.16,.12][variant]+side*wind*.055;
      else if(bone==='neck_01'||bone==='Head')pitch=[0,-.17,-.24][variant]+wind*.035;
      else if(bone==='spine_02')pitch=[0,-.05,-.10][variant]+wind*.028;
      const correction=Quaternion.RotationAxis(Vector3.Right(),pitch).multiply(Quaternion.RotationAxis(Vector3.Forward(),roll));
      const q=basis.conjugate().multiply(correction).multiply(basis).multiply(base).normalize();
      values.push(...q.asArray());
    }
    track(clip,node,'rotation',time,values);
  }
}
// Keep every animated property defined while switching between clips.
const properties=new Map();
for(const clip of root.listAnimations())for(const c of clip.listChannels()){
  const node=c.getTargetNode(),path=c.getTargetPath();
  if(path==='rotation'||path==='translation')properties.set(node.getName()+'/'+path,{node,path});
}
const zero=model.createAccessor().setBuffer(buffer).setType(Accessor.Type.SCALAR).setArray(new Float32Array([0]));
for(const clip of root.listAnimations()){
  const present=new Set(clip.listChannels().map(c=>c.getTargetNode().getName()+'/'+c.getTargetPath()));
  for(const [key,{node,path}] of properties)if(!present.has(key))track(clip,node,path,zero,path==='rotation'?node.getRotation():node.getTranslation());
}
await model.transform(resample(),prune(),dedup());
// Keep the new clips within the existing GLB budget without changing the atlas pixels.
const normal=root.listTextures().find(t=>t.getName()==='human-normal');
if(normal?.getMimeType()==='image/png'){
  const original=normal.getImage();
  const webp=await sharp(original).webp({lossless:true,effort:6}).toBuffer();
  const decoded=await Promise.all([original,webp].map(data=>sharp(data).ensureAlpha().raw().toBuffer()));
  assert.ok(decoded[0].equals(decoded[1]));
  normal.setImage(webp).setMimeType('image/webp');
}
await io.write(file,model);
const manifestFile='public/models/human/manifest.json';
const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
manifest.runtimeClips=root.listAnimations().map(a=>a.getName());
manifest.textures=root.listTextures().map(t=>({name:t.getName(),mime:t.getMimeType(),size:t.getSize()}));
manifest.locomotionAnimations={swim,flight,posture,swimLibrary:'https://quaternius.com/packs/universalanimationlibrary.html',
  swimArchive:'https://github.com/Barbatos6669/elderforge/tree/main/assets/animations/universal_animation_library_1',
  swimSourceSha256:createHash('sha256').update(await readFile(source)).digest('hex'),flightSource:'Original poses authored on the project rig',
  postureArchive:'https://github.com/tilakpatell/tilakverse-assets/tree/main/quaternius/universal-animation-library',
  postureSourceSha256:createHash('sha256').update(await readFile(postureSource)).digest('hex')};
manifest.sha256=createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
