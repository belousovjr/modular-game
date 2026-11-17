import { NodeIO, Accessor } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { copyToDocument, dedup, prune, weld, simplify, resample, unpartition, joinPrimitives } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { retargetClips } from './retarget-character.mjs';

// Offline only. Inputs are fresh author downloads, never assets from another project.
if (!process.argv[2]) throw new Error('Usage: node scripts/prepare-character.mjs <prepared-source-directory>');
const source = resolve(process.argv[2]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const model = await io.read(resolve(source,'model/Male_Peasant.gltf'));
const base = await io.read(resolve(source,'base/Superhero_Male_FullBody.gltf'));
const hair = await io.read(resolve(source,'base/Hair_SimpleParted.gltf'));
const library1 = await io.read(resolve(source,'universal-animation-library-UAL1_Standard.glb'));
const library2 = await io.read(resolve(source,'universal-animation-library-2-UAL2_Standard.glb'));
const root = model.getRoot();
const skin = root.listSkins()[0];
const names = new Map(skin.listJoints().map((node,i)=>[node.getName(),i]));
const meshParent = root.listNodes().find(node=>node.getSkin())?.getParentNode();
assert.ok(meshParent);
const body = base.getRoot().listMeshes().find(mesh=>mesh.getName().startsWith('Sphere'));
assert.ok(body);
// Keep the anatomically modelled head/neck, not the superhero torso under the outfit.
const baseSkin = base.getRoot().listSkins()[0];
const neckJoints = new Set(baseSkin.listJoints().flatMap((j,i)=>['Head','neck_01'].includes(j.getName())?[i]:[]));
for (const p of body.listPrimitives()) {
  const indices=p.getIndices(), joints=p.getAttribute('JOINTS_0'), weights=p.getAttribute('WEIGHTS_0');
  const kept=[];
  const head = vertex => {
    const js=joints.getElement(vertex,[]), ws=weights.getElement(vertex,[]);
    return js.reduce((sum,j,i)=>sum+(neckJoints.has(j)?ws[i]:0),0)>.45;
  };
  for(let i=0;i<indices.getCount();i+=3) {
    const tri=[indices.getScalar(i),indices.getScalar(i+1),indices.getScalar(i+2)];
    if(tri.some(head))kept.push(...tri);
  }
  const weightsArray=new Float32Array(weights.getArray());
  const jointsArray=new Uint16Array(joints.getArray());
  const valid=new Set(baseSkin.listJoints().flatMap((j,i)=>['Head','neck_01','spine_03'].includes(j.getName())?[i]:[]));
  for(const vertex of new Set(kept)) {
    let sum=0;
    for(let k=0;k<4;k++){if(!valid.has(jointsArray[vertex*4+k]))weightsArray[vertex*4+k]=0;sum+=weightsArray[vertex*4+k];}
    if(sum<1e-8){jointsArray[vertex*4]=baseSkin.listJoints().findIndex(j=>j.getName()==='neck_01');weightsArray[vertex*4]=1;sum=1;}
    for(let k=0;k<4;k++)weightsArray[vertex*4+k]/=sum;
  }
  weights.setArray(weightsArray);joints.setArray(jointsArray);
  p.setIndices(base.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint32Array(kept)).setBuffer(base.getRoot().listBuffers()[0]));
}
let faceMaterial;
function addMeshes(document) {
  const originalSkin=document.getRoot().listSkins()[0];
  const jointMap=originalSkin.listJoints().map(j=>{const i=names.get(j.getName());assert.notEqual(i,undefined);return i;});
  // Only joints influencing the retained head/eyebrows/hair must share this bind pose.
  const used=new Set();
  for(const mesh of document.getRoot().listMeshes())for(const p of mesh.listPrimitives()) {
    const joints=p.getAttribute('JOINTS_0'),weights=p.getAttribute('WEIGHTS_0');
    for(const vertex of p.getIndices().getArray()) {
      const js=joints.getElement(vertex,[]),ws=weights.getElement(vertex,[]);
      for(let k=0;k<4;k++)if(ws[k]>.0001)used.add(js[k]);
    }
  }
  const targetBind=skin.getInverseBindMatrices(), sourceBind=originalSkin.getInverseBindMatrices();
  for(const i of used) {
    const a=sourceBind.getElement(i,[]), b=targetBind.getElement(jointMap[i],[]);
    assert.ok(a.every((v,k)=>Math.abs(v-b[k])<.0001),'Retained head bind rig mismatch: '+originalSkin.listJoints()[i].getName());
  }
  const mapping=copyToDocument(model,document,document.getRoot().listMeshes());
  for(const original of document.getRoot().listMeshes()) {
    const mesh=mapping.get(original);
    for(const p of mesh.listPrimitives()) {
      const a=p.getAttribute('JOINTS_0');
      const array=new Uint16Array(a.getCount()*4);
      for(let i=0;i<a.getCount();i++)for(let k=0;k<4;k++)array[i*4+k]=jointMap[a.getElement(i,[])[k]];
      a.setArray(array);
      if(original===body)faceMaterial=p.getMaterial();
    }
    meshParent.addChild(model.createNode('human/'+original.getName()).setMesh(mesh).setSkin(skin));
  }
}
addMeshes(base);addMeshes(hair);
assert.ok(faceMaterial);
for(const m of root.listMeshes())for(const p of m.listPrimitives())if(p.getMaterial()?.getName()==='MI_Regular_Male')p.setMaterial(faceMaterial);
const clips=['Idle_Loop','Walk_Loop','Jog_Fwd_Loop','Sprint_Loop','Jump_Start','Jump_Loop','Jump_Land','Driving_Loop'];
retargetClips(model,library1,clips);
for(const lib of [library1,library2])for(const joint of lib.getRoot().listSkins()[0].listJoints())assert.ok(names.has(joint.getName()));
await MeshoptSimplifier.ready;
await model.transform(prune(),dedup(),weld(),simplify({simplifier:MeshoptSimplifier,ratio:.28,error:.008}),resample(),prune(),dedup());
// One material/one draw call: atlas the original cloth, skin, hair and eyes.
const materials=root.listMaterials();assert.ok(materials.length<=4);
const colorTiles=[],normalTiles=[],ranges=[];
const snap=v=>Math.abs(v-Math.round(v))<.0001?Math.round(v):v;
for(const material of materials) {
  let minU=Infinity,minV=Infinity,maxU=-Infinity,maxV=-Infinity;
  for(const mesh of root.listMeshes())for(const p of mesh.listPrimitives())if(p.getMaterial()===material) {
    const a=p.getAttribute('TEXCOORD_0').getArray();
    for(let i=0;i<a.length;i+=2){minU=Math.min(minU,snap(a[i]));maxU=Math.max(maxU,snap(a[i]));minV=Math.min(minV,snap(a[i+1]));maxV=Math.max(maxV,snap(a[i+1]));}
  }
  const u=Math.floor(minU),v=Math.floor(minV),width=Math.max(1,Math.ceil(maxU)-u),height=Math.max(1,Math.ceil(maxV)-v);
  assert.ok(width<=8&&height<=8);ranges.push({u,v,width,height});
}
async function repeated(image,size,range) {
  const tile=await sharp(Buffer.from(image)).resize(size,size,{fit:'fill'}).ensureAlpha().png().toBuffer();
  const pieces=[];for(let x=0;x<range.width;x++)for(let y=0;y<range.height;y++)pieces.push({input:tile,left:x*size,top:y*size});
  return sharp({create:{width:size*range.width,height:size*range.height,channels:4,background:{r:0,g:0,b:0,alpha:1}}}).composite(pieces).png().toBuffer();
}
for(let i=0;i<materials.length;i++) {
  const m=materials[i];
  if(m.getName()==='MI_Hair_1')m.setBaseColorFactor([.12,.065,.025,1]);
  const factor=m.getBaseColorFactor();
  const color=await sharp(await repeated(m.getBaseColorTexture().getImage(),512,ranges[i])).resize(508,508,{fit:'fill'}).ensureAlpha().linear([factor[0]**(1/2.2),factor[1]**(1/2.2),factor[2]**(1/2.2),factor[3]],[0,0,0,0]).extend({top:2,bottom:2,left:2,right:2,extendWith:'copy'}).png().toBuffer();
  const normal=m.getNormalTexture()?await sharp(await repeated(m.getNormalTexture().getImage(),256,ranges[i])).resize(254,254,{fit:'fill'}).ensureAlpha().extend({top:1,bottom:1,left:1,right:1,extendWith:'copy'}).png().toBuffer():await sharp({create:{width:256,height:256,channels:4,background:{r:128,g:128,b:255,alpha:1}}}).png().toBuffer();
  colorTiles.push({input:color,left:(i%2)*512,top:Math.floor(i/2)*512});
  normalTiles.push({input:normal,left:(i%2)*256,top:Math.floor(i/2)*256});
}
const color=await sharp({create:{width:1024,height:1024,channels:4,background:{r:0,g:0,b:0,alpha:1}}}).composite(colorTiles).webp({quality:90,alphaQuality:100}).toBuffer();
const normal=await sharp({create:{width:512,height:512,channels:4,background:{r:128,g:128,b:255,alpha:1}}}).composite(normalTiles).png().toBuffer();
const atlasMaterial=model.createMaterial('Human').setBaseColorTexture(model.createTexture('human-color').setImage(color).setMimeType('image/webp')).setNormalTexture(model.createTexture('human-normal').setImage(normal).setMimeType('image/png')).setMetallicFactor(0).setRoughnessFactor(.75).setAlphaMode('MASK').setAlphaCutoff(.45).setDoubleSided(true);
const primitives=[];
for(const node of root.listNodes().filter(n=>n.getSkin()===skin&&n.getMesh())) {
  assert.ok(node.getMatrix().every((v,i)=>Math.abs(v-([0,5,10,15].includes(i)?1:0))<1e-5),'Unexpected mesh transform');
  for(const p of node.getMesh().listPrimitives()) {
    const slot=materials.indexOf(p.getMaterial());assert.ok(slot>=0);
    const uv=p.getAttribute('TEXCOORD_0'),array=new Float32Array(uv.getArray());
    for(let i=0;i<array.length;i+=2) {
      const range=ranges[slot];
      array[i]=(((snap(array[i])-range.u)/range.width)*508+2+(slot%2)*512)/1024;
      array[i+1]=(((snap(array[i+1])-range.v)/range.height)*508+2+Math.floor(slot/2)*512)/1024;
    }
    uv.setArray(array);p.setAttribute('COLOR_0',null);p.setAttribute('TANGENT',null);
    p.getAttribute('JOINTS_0').setArray(new Uint16Array(p.getAttribute('JOINTS_0').getArray()));
    p.setMaterial(atlasMaterial);primitives.push(p);
  }
  node.setMesh(null);node.setSkin(null);node.dispose();
}
meshParent.addChild(model.createNode('Human').setMesh(model.createMesh('Human').addPrimitive(joinPrimitives(primitives))).setSkin(skin));
await model.transform(prune(),dedup(),weld(),unpartition());
const triangles=root.listMeshes().reduce((n,m)=>n+m.listPrimitives().reduce((n,p)=>n+p.getIndices().getCount()/3,0),0);
const output=resolve('public/models/human');await mkdir(output,{recursive:true});
await io.write(resolve(output,'character.glb'),model);
const manifest={source:'Quaternius: Modular Character Outfits – Fantasy + Universal Base Characters',license:'CC0-1.0',
  triangles,primitives:root.listMeshes().reduce((n,m)=>n+m.listPrimitives().length,0),joints:skin.listJoints().length,
  textures:root.listTextures().map(t=>({name:t.getName(),mime:t.getMimeType(),size:t.getSize()})),runtimeClips:clips,
  animationLibraries:[{name:'Universal Animation Library',url:'https://quaternius.com/packs/universalanimationlibrary.html',advertisedFullClips:'120+',verifiedFreeClips:library1.getRoot().listAnimations().map(a=>a.getName())},
   {name:'Universal Animation Library 2',url:'https://quaternius.com/packs/universalanimationlibrary2.html',advertisedFullClips:'130+',verifiedFreeClips:library2.getRoot().listAnimations().map(a=>a.getName())}],
  sha256:createHash('sha256').update(await readFile(resolve(output,'character.glb'))).digest('hex')};
await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({triangles,primitives:manifest.primitives,joints:manifest.joints,textures:manifest.textures,clips,bytes:(await readFile(resolve(output,'character.glb'))).length}));
