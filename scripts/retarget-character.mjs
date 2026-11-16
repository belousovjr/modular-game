import { Accessor, MathUtils } from '@gltf-transform/core';
import { Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector.js';
import assert from 'node:assert/strict';

// Offline humanoid retargeting in mesh space; differing bind poses are corrected before export.
export function retargetClips(target, source, names) {
  const targetSkin=target.getRoot().listSkins()[0], sourceSkin=source.getRoot().listSkins()[0];
  const targetNodes=new Map(targetSkin.listJoints().map(n=>[n.getName(),n]));
  function binds(skin) {
    const matrices=new Map(skin.listJoints().map((n,i)=>[n,Matrix.FromArray(skin.getInverseBindMatrices().getElement(i,[])).invert()]));
    const data=new Map();
    for(const [n,m]of matrices) {
      const parent=n.getParentNode(), parentMatrix=matrices.get(parent) ?? (parent?Matrix.FromArray(parent.getWorldMatrix()):Matrix.Identity());
      const t=[],q=[],s=[];
      MathUtils.decompose(Array.from(m.asArray()),t,q,s);
      // Matrix numeric inversion is independent of Babylon scene handedness.
      const local=m.multiply(parentMatrix.clone().invert());
      const lt=[],lq=[],ls=[];MathUtils.decompose(Array.from(local.asArray()),lt,lq,ls);
      data.set(n,{globalQ:Quaternion.FromArray(q),localT:lt,localQ:lq,localS:ls});
    }
    return data;
  }
  const sb=binds(sourceSkin),tb=binds(targetSkin);
  for(const name of names) {
    const animation=source.getRoot().listAnimations().find(a=>a.getName()===name);assert.ok(animation);
    const end=Math.max(...animation.listSamplers().map(s=>s.getInput().getMax([])[0]));
    const count=Math.ceil(end*30),times=Float32Array.from({length:count+1},(_,i)=>end*i/count);
    const rotations=new Map([...targetNodes.values()].map(n=>[n,[]])),translations=new Map([...targetNodes.values()].map(n=>[n,[]]));
    function sample(channel,time) {
      const sampler=channel.getSampler(),input=sampler.getInput(),output=sampler.getOutput();
      assert.ok(['LINEAR','STEP'].includes(sampler.getInterpolation()));
      let i=0;while(i+1<input.getCount()&&input.getScalar(i+1)<=time)i++;
      const j=Math.min(i+1,input.getCount()-1),a=output.getElement(i,[]),b=output.getElement(j,[]);
      const alpha=sampler.getInterpolation()==='STEP'||i===j?0:(time-input.getScalar(i))/(input.getScalar(j)-input.getScalar(i));
      return channel.getTargetPath()==='rotation'?Quaternion.Slerp(Quaternion.FromArray(a),Quaternion.FromArray(b),alpha).normalize().asArray():a.map((v,k)=>v+(b[k]-v)*alpha);
    }
    for(const time of times) {
      for(const [n,bind]of sb)n.setTranslation(bind.localT).setRotation(bind.localQ).setScale(bind.localS);
      for(const channel of animation.listChannels()) {
        const node=channel.getTargetNode(),value=sample(channel,time);
        if(channel.getTargetPath()==='rotation')node.setRotation(value);
        else if(channel.getTargetPath()==='translation')node.setTranslation(value);
        else if(channel.getTargetPath()==='scale')node.setScale(value);
      }
      const desired=new Map();
      for(const sn of sourceSkin.listJoints()) {
        const tn=targetNodes.get(sn.getName());assert.ok(tn);
        const current=Quaternion.FromArray(sn.getWorldRotation());
        desired.set(tn,current.multiply(sb.get(sn).globalQ.conjugate()).multiply(tb.get(tn).globalQ).normalize());
      }
      for(const sn of sourceSkin.listJoints()) {
        const tn=targetNodes.get(sn.getName()),parent=tn.getParentNode();
        const parentQ=desired.get(parent)??(parent?Quaternion.FromArray(parent.getWorldRotation()):Quaternion.Identity());
        let q=parentQ.conjugate().multiply(desired.get(tn)).normalize();
        const values=rotations.get(tn),last=values.length?Quaternion.FromArray(values,values.length-4):null;
        if(last&&Quaternion.Dot(last,q)<0)q=q.scale(-1);
        values.push(...q.asArray());
        const sourceT=sn.getTranslation(),sourceBindT=sb.get(sn).localT,targetBindT=tb.get(tn).localT;
        translations.get(tn).push(...targetBindT.map((v,i)=>v+sourceT[i]-sourceBindT[i]));
      }
    }
    const buffer=target.getRoot().listBuffers()[0];
    const input=target.createAccessor().setType(Accessor.Type.SCALAR).setArray(times).setBuffer(buffer);
    const output=target.createAnimation(name);
    for(const node of targetNodes.values())for(const [path,data,type]of [['rotation',rotations.get(node),Accessor.Type.VEC4],['translation',translations.get(node),Accessor.Type.VEC3]]) {
      const values=target.createAccessor().setType(type).setArray(new Float32Array(data)).setBuffer(buffer);
      const sampler=target.createAnimationSampler().setInput(input).setOutput(values).setInterpolation('LINEAR');
      output.addSampler(sampler).addChannel(target.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath(path));
    }
  }
  // Bones that stay at bind pose in every clip need no per-frame animation work.
  const animated=new Set();
  for(const animation of target.getRoot().listAnimations())for(const channel of animation.listChannels()) {
    const node=channel.getTargetNode(),path=channel.getTargetPath(),bind=tb.get(node);
    const reference=path==='rotation'?bind.localQ:bind.localT;
    const values=channel.getSampler().getOutput().getArray();
    if(values.some((v,i)=>Math.abs(v-reference[i%reference.length])>1e-6))animated.add(`${node.getName()}/${path}`);
  }
  let removed=0;
  for(const animation of target.getRoot().listAnimations())for(const channel of animation.listChannels()) {
    if(animated.has(`${channel.getTargetNode().getName()}/${channel.getTargetPath()}`))continue;
    const sampler=channel.getSampler();animation.removeChannel(channel);channel.dispose();
    animation.removeSampler(sampler);sampler.dispose();removed++;
  }
  console.log(`Removed ${removed} globally static bone tracks`);
  for(const [n,bind]of tb)n.setTranslation(bind.localT).setRotation(bind.localQ).setScale(bind.localS);
}
