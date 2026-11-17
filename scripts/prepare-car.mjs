import {NodeIO,Accessor} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {dedup,prune,weld,simplify,joinPrimitives} from '@gltf-transform/functions';
import {MeshoptSimplifier} from 'meshoptimizer';
import sharp from 'sharp';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS),source=process.argv[2];
if(!source)throw Error('Usage: node scripts/prepare-car.mjs <Especial Car_5NL.glb>');
const d=await io.read(source),r=d.getRoot(),buffer=r.listBuffers()[0];
for(const n of r.listNodes())if(/Attachment|Speedometer|Tachometer/.test(n.getName()))n.dispose();
await MeshoptSimplifier.ready;await d.transform(prune(),dedup(),weld(),simplify({simplifier:MeshoptSimplifier,ratio:.23,error:.025}));
const palette=await sharp(r.listTextures()[0].getImage()).removeAlpha().raw().toBuffer({resolveWithObject:true});
const colorAt=([u,v])=>{const x=Math.min(511,Math.floor((u-Math.floor(u))*512)),y=Math.min(511,Math.floor((v-Math.floor(v))*512));return [...palette.data.subarray((y*512+x)*3,(y*512+x)*3+3)];};
for(const m of r.listMeshes())for(const p of m.listPrimitives()){
  const ids=p.getIndices(),pos=p.getAttribute('POSITION'),norm=p.getAttribute('NORMAL'),uv=p.getAttribute('TEXCOORD_0');
  if(ids.getCount()>300){const attrs=new Float32Array(pos.getCount()*6);for(let i=0;i<pos.getCount();i++)attrs.set([...norm.getElement(i,[]),...colorAt(uv?.getElement(i,[])??[0,0]).map(v=>v/255)],i*6);
    const [indices]=MeshoptSimplifier.simplifyWithAttributes(new Uint32Array(ids.getArray()),new Float32Array(pos.getArray()),3,attrs,6,[.15,.15,.15,2,2,2],null,Math.max(30,Math.floor(ids.getCount()*.35/3)*3),.08,['Permissive']);ids.setArray(indices);
  }
}
// Each wheel instance gets private mutable geometry before scaling/UV baking.
for(const n of r.listNodes())if(n.getMesh()){
  const originalMesh=n.getMesh(),mesh=originalMesh.clone();
  for(const old of mesh.listPrimitives()){
    mesh.removePrimitive(old);const p=old.clone();
    for(const semantic of old.listSemantics()){const a=old.getAttribute(semantic);p.setAttribute(semantic,a.clone().setArray(a.getArray().slice()));}
    if(old.getIndices())p.setIndices(old.getIndices().clone().setArray(old.getIndices().getArray().slice()));
    mesh.addPrimitive(p);
  }
  n.setMesh(mesh);
}
await d.transform(prune());
const scale=.98;
for(const n of r.listNodes()){
  const t=n.getTranslation();n.setTranslation([t[0]*scale,t[1]*scale,t[2]*scale]);
  if(!n.getMesh())continue;
  for(const p of n.getMesh().listPrimitives()){
    for(const semantic of ['POSITION','NORMAL']){
      const a=p.getAttribute(semantic),v=new Float32Array(a.getArray());
      for(let i=0;i<v.length;i+=3){v[i]*=semantic==='POSITION'?scale:1;if(semantic==='POSITION'){v[i+1]*=scale;v[i+2]*=scale;}}
      a.setArray(v);
    }
    const a=p.getIndices(),v=new Uint32Array(a.getArray());a.setArray(v);
  }
  const name=n.getName();
  if(name.endsWith(' Tire')&&!name.includes('Rear'))n.setName(`wheel/${n.getTranslation()[2]>0?'front':'rear'}/${n.getTranslation()[0]>0?'left':'right'}`);
  else if(name.endsWith(' Door'))n.setName(`door/${n.getTranslation()[0]>0?'left':'right'}`);
  else if(name.endsWith('Stearing'))n.setName('steering');else n.setName('body/'+name);
}
const primitives=r.listMeshes().flatMap(m=>m.listPrimitives());
const count=primitives.reduce((n,p)=>n+p.getIndices().getCount()/3,0);assert.ok(count<12000,`Too many triangles: ${count}`);

const sub=(a,b)=>a.map((v,i)=>v-b[i]),dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],unit=a=>{const l=Math.hypot(...a)||1;return a.map(v=>v/l);};
const triangles=[];
for(const n of r.listNodes())if(n.getMesh())for(const p of n.getMesh().listPrimitives()){
  const a=p.getAttribute('POSITION'),ids=p.getIndices(),t=n.getWorldTranslation();
  for(let i=0;i<ids.getCount();i+=3){const vs=[0,1,2].map(k=>a.getElement(ids.getScalar(i+k),[]).map((v,j)=>v+t[j]));triangles.push(vs);}
}
function tree(ts){const min=[0,1,2].map(i=>Math.min(...ts.flatMap(t=>t.map(v=>v[i])))),max=[0,1,2].map(i=>Math.max(...ts.flatMap(t=>t.map(v=>v[i]))));if(ts.length<12)return{min,max,ts};const spans=sub(max,min),axis=spans.indexOf(Math.max(...spans));ts.sort((a,b)=>a.reduce((n,v)=>n+v[axis],0)-b.reduce((n,v)=>n+v[axis],0));const half=ts.length>>1;return{min,max,left:tree(ts.slice(0,half)),right:tree(ts.slice(half))};}
const bvh=tree([...triangles]);
function hit(node,o,dir){let lo=0,hi=.9;for(let i=0;i<3;i++){if(Math.abs(dir[i])<1e-8){if(o[i]<node.min[i]||o[i]>node.max[i])return false;}else{const a=(node.min[i]-o[i])/dir[i],b=(node.max[i]-o[i])/dir[i];lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));if(lo>hi)return false;}}if(!node.ts)return hit(node.left,o,dir)||hit(node.right,o,dir);return node.ts.some(([a,b,c])=>{const e1=sub(b,a),e2=sub(c,a),h=cross(dir,e2),det=dot(e1,h);if(Math.abs(det)<1e-8)return false;const s=sub(o,a),u=dot(s,h)/det;if(u<0||u>1)return false;const q=cross(s,e1),v=dot(dir,q)/det;if(v<0||u+v>1)return false;const t=dot(e2,q)/det;return t>.005&&t<.9;});}
const atlasSize=count<=4096?512:1024;
const image=Buffer.alloc(atlasSize*atlasSize*3),material=d.createMaterial('car/textured').setRoughnessFactor(.72).setMetallicFactor(.1).setDoubleSided(true);
const glass=d.createMaterial('car/glass').setRoughnessFactor(.18).setMetallicFactor(0).setBaseColorFactor([.65,.8,.85,.3]).setAlphaMode('BLEND').setDoubleSided(true);
let chart=0;
for(const n of r.listNodes())if(n.getMesh())for(const p of n.getMesh().listPrimitives()){
  const oldPos=p.getAttribute('POSITION'),oldNorm=p.getAttribute('NORMAL'),oldUv=p.getAttribute('TEXCOORD_0'),oldIds=p.getIndices(),pos=[],norm=[],uv=[],detailUv=[],ids=[],t=n.getWorldTranslation(),isGlass=p.getMaterial().getName()==='Glass';
  for(let i=0;i<oldIds.getCount();i+=3){
    const vi=[0,1,2].map(k=>oldIds.getScalar(i+k)),vs=vi.map(v=>oldPos.getElement(v,[])),ns=vi.map(v=>oldNorm.getElement(v,[])),us=vi.map(v=>oldUv?.getElement(v,[])??[.5,.5]);
    const center=[0,1,2].map(j=>vs.reduce((s,v)=>s+v[j]/3,t[j])),normal=unit(ns.reduce((s,v)=>s.map((x,j)=>x+v[j]),[0,0,0]));
    const tangent=unit(cross(normal,Math.abs(normal[1])<.9?[0,1,0]:[1,0,0])),bitangent=cross(normal,tangent),origin=center.map((v,j)=>v+normal[j]*.015);
    let blocked=0;for(let k=0;k<8;k++){const h=(k+.5)/8,angle=k*2.3999632297,rad=Math.sqrt(1-h*h),dir=normal.map((v,j)=>v*h+rad*(tangent[j]*Math.cos(angle)+bitangent[j]*Math.sin(angle)));if(hit(bvh,origin,dir))blocked++;}
    const ao=isGlass?1:1-blocked/8*.35,cx=chart%(atlasSize/8)*8,cy=Math.floor(chart/(atlasSize/8))*8;chart++;
    for(let py=0;py<8;py++)for(let px=0;px<8;px++){
      let a=Math.max(0,Math.min(1,(px-1)/5)),b=Math.max(0,Math.min(1,(py-1)/5));if(a+b>1){const sum=a+b;a/=sum;b/=sum;}
      const colors=us.map(colorAt);
      for(let c=0;c<3;c++)image[((cy+py)*atlasSize+cx+px)*3+c]=Math.round((isGlass?200:colors[0][c]*(1-a-b)+colors[1][c]*a+colors[2][c]*b)*ao);
    }
    const faceNormal=ns[0],axis=faceNormal.map(Math.abs).indexOf(Math.max(...faceNormal.map(Math.abs)));
    for(let k=0;k<3;k++){detailUv.push(vs[k][(axis+1)%3]*4,vs[k][(axis+2)%3]*4);ids.push(ids.length);pos.push(...vs[k]);norm.push(...ns[k]);uv.push((cx+[1,6,1][k]+.5)/atlasSize,(cy+[1,1,6][k]+.5)/atlasSize);}
  }
  const accessor=(values,type,ArrayType=Float32Array)=>d.createAccessor().setBuffer(buffer).setType(type).setArray(new ArrayType(values));
  p.setAttribute('POSITION',accessor(pos,Accessor.Type.VEC3)).setAttribute('NORMAL',accessor(norm,Accessor.Type.VEC3)).setAttribute('TEXCOORD_0',accessor(uv,Accessor.Type.VEC2)).setAttribute('TEXCOORD_1',accessor(detailUv,Accessor.Type.VEC2)).setIndices(accessor(ids,Accessor.Type.SCALAR,Uint32Array)).setMaterial(isGlass?glass:material);
}
const atlas=d.createTexture('car/albedo-ao').setImage(await sharp(image,{raw:{width:atlasSize,height:atlasSize,channels:3}}).webp({quality:92}).toBuffer()).setMimeType('image/webp');material.setBaseColorTexture(atlas);glass.setBaseColorTexture(atlas);
const normal=d.createTexture('car/micro-normal').setImage(await readFile('public/textures/city/metal-normal.webp')).setMimeType('image/webp');material.setNormalTexture(normal).setNormalScale(.25);material.getNormalTextureInfo().setTexCoord(1);
for(const m of r.listMeshes()){const groups=new Map();for(const p of m.listPrimitives()){const list=groups.get(p.getMaterial())??[];list.push(p);groups.set(p.getMaterial(),list);}for(const p of m.listPrimitives())m.removePrimitive(p);for(const ps of groups.values())m.addPrimitive(joinPrimitives(ps));}
await d.transform(prune(),dedup());await mkdir('public/models/car',{recursive:true});await io.write('public/models/car/car.glb',d);
const metal=await sharp(await readFile('public/textures/city/metal-512.webp')).resize(512,512).removeAlpha().raw().toBuffer();const detail=Buffer.alloc(512*512*4);let average=0;for(let i=0;i<metal.length;i+=3)average+=(metal[i]+metal[i+1]+metal[i+2])/3/(512*512);for(let i=0;i<512*512;i++){const l=(metal[i*3]+metal[i*3+1]+metal[i*3+2])/3;detail[i*4]=Math.max(70,Math.min(186,128+(l-average)*1.8));detail[i*4+1]=128;detail[i*4+2]=150;detail[i*4+3]=128;}await writeFile('public/models/car/detail.png',await sharp(detail,{raw:{width:512,height:512,channels:4}}).png().toBuffer());
const manifest={source:'Awbmecreations Drivable-Free Low Poly Cars / Especial Car_5NL',url:'https://awbmecreations.itch.io/drivable-free-low-poly-cars',triangles:count,texture:[atlasSize,atlasSize],ao:'8 hemisphere rays per triangle, 0.9 m range; baked into albedo',scale:.98,mirroredX:false,sha256:createHash('sha256').update(await readFile('public/models/car/car.glb')).digest('hex')};await writeFile('public/models/car/manifest.json',JSON.stringify(manifest,null,2)+'\n');console.log(manifest);
