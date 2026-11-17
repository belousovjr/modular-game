import assimp from 'assimpjs';
import {NodeIO,Accessor,MathUtils} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {prune,dedup,resample} from '@gltf-transform/functions';
import {Matrix,Quaternion} from '@babylonjs/core/Maths/math.vector.js';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const source=process.argv[2];if(!source)throw Error('Usage: node scripts/prepare-car-animations.mjs <directory containing Entering_Car.fbx, Exiting_Car.fbx and Crawling.fbx>');
const converter=await assimp(),io=new NodeIO().registerExtensions(ALL_EXTENSIONS),file='public/models/human/character.glb',model=await io.read(file),r=model.getRoot(),skin=r.listSkins()[0],buffer=r.listBuffers()[0];
const joints=skin.listJoints(),target=new Map(joints.map(n=>[n.getName(),n])),bind=new Map();
// Preserve the outfit's actual bind pose.
for(const [i,n] of joints.entries()){
  const global=Matrix.FromArray(skin.getInverseBindMatrices().getElement(i,[])).invert(),parent=n.getParentNode(),pi=joints.indexOf(parent),pg=pi<0?Matrix.FromArray(parent?.getWorldMatrix()??Matrix.Identity().asArray()):Matrix.FromArray(skin.getInverseBindMatrices().getElement(pi,[])).invert();
  const t=[],q=[],s=[],gt=[],gq=[],gs=[];MathUtils.decompose(Array.from(global.multiply(pg.clone().invert()).asArray()),t,q,s);MathUtils.decompose(Array.from(global.asArray()),gt,gq,gs);bind.set(n,{t,q,s,gq:Quaternion.FromArray(gq)});
}
function reset(){for(const[n,b]of bind)n.setTranslation(b.t).setRotation(b.q).setScale(b.s);}
reset();const driving=r.listAnimations().find(a=>a.getName()==='Driving_Loop');assert.ok(driving);
for(const c of driving.listChannels()){const n=c.getTargetNode(),v=c.getSampler().getOutput().getElement(0,[]);if(c.getTargetPath()==='rotation')n.setRotation(v);if(c.getTargetPath()==='translation')n.setTranslation(v);}
const seatRotations=new Map(joints.map(n=>[n,Quaternion.FromArray(n.getRotation())]));
const pelvis=target.get('pelvis'),seatPosition=[...pelvis.getTranslation()],driveYaw=Quaternion.FromArray(pelvis.getWorldRotation()).toEulerAngles().y;reset();
for(const a of r.listAnimations())if(['Sitting_Enter','Sitting_Exit','Car_Enter','Car_Exit','Crawl_Loop'].includes(a.getName()))a.dispose();
const mapping={Hips:'pelvis',Spine:'spine_01',Spine1:'spine_02',Spine2:'spine_03',Neck:'neck_01',Head:'Head'};
for(const[side,suffix]of[['Left','l'],['Right','r']]){
  for(const[src,dst]of[['Shoulder','clavicle'],['Arm','upperarm'],['ForeArm','lowerarm'],['Hand','hand'],['UpLeg','thigh'],['Leg','calf'],['Foot','foot'],['ToeBase','ball']])mapping[side+src]=dst+'_'+suffix;
  for(const finger of ['Thumb','Index','Middle','Ring','Pinky'])for(let i=1;i<=3;i++)mapping[side+'Hand'+finger+i]=finger.toLowerCase()+'_0'+i+'_'+suffix;
}
function sample(c,time){const s=c.getSampler(),ts=s.getInput(),out=s.getOutput();let k=0;while(k+1<ts.getCount()&&ts.getScalar(k+1)<=time)k++;const j=Math.min(k+1,ts.getCount()-1),alpha=k===j?0:(time-ts.getScalar(k))/(ts.getScalar(j)-ts.getScalar(k)),a=out.getElement(k,[]),b=out.getElement(j,[]);return c.getTargetPath()==='rotation'?Quaternion.Slerp(Quaternion.FromArray(a),Quaternion.FromArray(b),alpha).normalize().asArray():a.map((v,i)=>v+(b[i]-v)*alpha);}
const metadata=[];
for(const [input,name,enter]of[['Entering_Car','Car_Enter',true],['Exiting_Car','Car_Exit',false],['Crawling','Crawl_Loop',false]]){
  const bytes=await readFile(source+'/'+input+'.fbx'),files=new converter.FileList();files.AddFile(input+'.fbx',new Uint8Array(bytes));const out=converter.ConvertFileList(files,'glb2');assert.ok(out.IsSuccess());
  const d=await io.readBinary(out.GetFile(0).GetContent()),animation=d.getRoot().listAnimations()[0],end=Math.max(...animation.listSamplers().map(s=>s.getInput().getMax([])[0]));
  const nodes=new Map(d.getRoot().listNodes().map(n=>[n.getName(),n]));
  const links=Object.entries(mapping).map(([src,dst])=>({src:nodes.get('mixamorig:'+src),dst:target.get(dst)})).filter(p=>p.src&&p.dst);
  const crawl=name==='Crawl_Loop',sourceStandingY=nodes.get('mixamorig:Hips').getWorldTranslation()[1]*.01;
  const sourceBind=new Map(links.map(p=>[p.src,Quaternion.FromArray(p.src.getWorldRotation())]));
  // Assimp exports complete animated local transforms; its FBX pivot helpers must not be applied a second time.
  for(const n of d.getRoot().listNodes())if(n.getName().includes('_$AssimpFbx$'))n.setTranslation([0,0,0]).setRotation([0,0,0,1]).setScale([1,1,1]);
  const apply=t=>{for(const c of animation.listChannels()){const n=c.getTargetNode(),v=sample(c,t);if(c.getTargetPath()==='rotation')n.setRotation(v);if(c.getTargetPath()==='translation')n.setTranslation(v);if(c.getTargetPath()==='scale')n.setScale(v);}};
  const hips=nodes.get('mixamorig:Hips');apply(0);const startY=hips.getTranslation()[1];apply(end);const lastY=hips.getTranslation()[1];
  const alignAt=enter?end:0;apply(alignAt);
  const raw=Quaternion.FromArray(hips.getWorldRotation()).multiply(sourceBind.get(hips).conjugate()).multiply(bind.get(pelvis).gq);
  const alignment=Quaternion.RotationYawPitchRoll(driveYaw-raw.toEulerAngles().y+(crawl?.5:0),0,0);
  const duration=end/(crawl?1:1.5),count=Math.ceil(duration*30),times=Float32Array.from({length:count+1},(_,i)=>duration*i/count),tracks=new Map(joints.map(n=>[n,[]])),positions=[];
  for(let frame=0;frame<=count;frame++){
    const t=end*frame/count,progress=frame/count;apply(t);const desired=new Map();
    for(const n of joints){const parent=n.getParentNode(),b=bind.get(n),link=links.find(p=>p.dst===n),parentQ=desired.get(parent)??Quaternion.FromArray(parent?.getWorldRotation()??[0,0,0,1]);
      const global=link?alignment.multiply(Quaternion.FromArray(link.src.getWorldRotation()).multiply(sourceBind.get(link.src).conjugate()).multiply(b.gq)):parentQ.multiply(Quaternion.FromArray(b.q));
      let q=parentQ.conjugate().multiply(global).normalize();
      if(enter){const u=Math.max(0,Math.min(1,(progress-.88)/.12));q=Quaternion.Slerp(q,seatRotations.get(n),u*u*(3-2*u));}
      const values=tracks.get(n);if(values.length&&Quaternion.Dot(Quaternion.FromArray(values,values.length-4),q)<0)q.scaleInPlace(-1);values.push(...q.asArray());desired.set(n,global);
    }
    const standing=bind.get(pelvis).t,from=enter?standing:seatPosition,to=enter?seatPosition:standing,rawY=(hips.getTranslation()[1]-startY)*.01,rawEnd=(lastY-startY)*.01,blend=progress*progress*(3-2*progress);
    // This outfit's skeletal parent is Z-up locally although the glTF world is Y-up.
    const parent=pelvis.getParentNode().getWorldMatrix(),up=[parent[1],parent[5],parent[9]],axis=up.map(Math.abs).indexOf(Math.max(...up.map(Math.abs)));
    const translation=from.map((v,j)=>v+(to[j]-v)*blend);translation[axis]=from[axis]+rawY/up[axis]+(to[axis]-from[axis]-rawEnd/up[axis])*blend;
    if(enter){const u=Math.max(0,Math.min(1,(progress-.88)/.12)),w=u*u*(3-2*u);for(let j=0;j<3;j++)translation[j]+=(seatPosition[j]-translation[j])*w;}
    if(crawl){for(let j=0;j<3;j++)translation[j]=standing[j];translation[axis]+=(hips.getTranslation()[1]*.01-sourceStandingY+.12)/up[axis];}
    positions.push(...translation);
  }
  const clip=model.createAnimation(name),time=model.createAccessor().setBuffer(buffer).setType(Accessor.Type.SCALAR).setArray(times);
  const add=(node,path,values,type)=>{const data=model.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(values)),s=model.createAnimationSampler().setInput(time).setOutput(data).setInterpolation('LINEAR');clip.addSampler(s).addChannel(model.createAnimationChannel().setSampler(s).setTargetNode(node).setTargetPath(path));};
  for(const n of joints)add(n,'rotation',tracks.get(n),Accessor.Type.VEC4);add(pelvis,'translation',positions,Accessor.Type.VEC3);
  metadata.push({clip:name,sourceClip:input.replaceAll('_',' '),url:'https://huggingface.co/datasets/Linzhan/Mixamo-Animations-Characters/resolve/main/animation/'+input+'.fbx',license:'Adobe Mixamo terms; game use, not CC0',sha256:createHash('sha256').update(bytes).digest('hex'),duration,playbackSourceRate:crawl?1:1.5});
}
reset();
// Every clip restores any bone/property that another clip animates.
const properties=new Map();for(const a of r.listAnimations())for(const c of a.listChannels())properties.set(c.getTargetNode().getName()+'/'+c.getTargetPath(),{node:c.getTargetNode(),path:c.getTargetPath()});
for(const a of r.listAnimations())for(const {node,path}of properties.values())if(!a.listChannels().some(c=>c.getTargetNode()===node&&c.getTargetPath()===path)){
  const input=model.createAccessor().setBuffer(buffer).setType(Accessor.Type.SCALAR).setArray(new Float32Array([0])),output=model.createAccessor().setBuffer(buffer).setType(path==='rotation'?Accessor.Type.VEC4:Accessor.Type.VEC3).setArray(new Float32Array(path==='rotation'?bind.get(node).q:bind.get(node).t)),s=model.createAnimationSampler().setInput(input).setOutput(output);a.addSampler(s).addChannel(model.createAnimationChannel().setSampler(s).setTargetNode(node).setTargetPath(path));
}
await model.transform(resample(),prune(),dedup());await io.write(file,model);
const manifest=JSON.parse(await readFile('public/models/human/manifest.json','utf8'));manifest.runtimeClips=r.listAnimations().map(a=>a.getName());manifest.vehicleAnimations=metadata;manifest.license='CC0-1.0 model/Quaternius clips; Adobe Mixamo terms for Car_Enter/Car_Exit/Crawl_Loop';manifest.sha256=createHash('sha256').update(await readFile(file)).digest('hex');await writeFile('public/models/human/manifest.json',JSON.stringify(manifest,null,2)+'\n');console.log(metadata);console.log('bytes',(await readFile(file)).length);
