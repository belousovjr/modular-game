// Build the runtime rigs from the free Quaternius Standard archive and existing game clips.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {NodeIO,PropertyType} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {copyToDocument,dedup,prune,resample,simplify,unpartition,weld} from '@gltf-transform/functions';
import {MeshoptSimplifier} from 'meshoptimizer';
import sharp from 'sharp';
import {retargetClips} from './retarget-character.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/prepare-modular-characters.mjs <extracted-source-directory>');
const input=process.argv[2];
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS);
const output='public/models/human';
const bodies=[
  {id:'male',file:'Superhero_Male_FullBody',hair:['Buzzed','SimpleParted','Beard']},
  {id:'female',file:'Superhero_Female_FullBody',hair:['BuzzedFemale','Buns','Long']},
];
await MeshoptSimplifier.ready;
const catalog={bodies:{}};
for(const body of bodies){
  const document=await io.read(join(input,'bodies',body.file+'.gltf'));
  const source=await io.read('scripts/character.glb');
  const root=document.getRoot(),skin=root.listSkins()[0];
  const names=skin.listJoints().map(joint=>joint.getName());
  const bodyNodes=root.listNodes().filter(node=>node.getMesh());
  const main=bodyNodes.find(node=>node.getName().toLowerCase().startsWith('superhero'));
  assert.ok(main);
  const parent=main.getParentNode(),height=main.getMesh().listPrimitives()[0].getAttribute('POSITION');
  const minY=height.getMin([])[1],maxY=height.getMax([])[1];
  const materials=Object.fromEntries(bodyNodes.map(node=>[
    node===main?'skin':node.getName()==='Eyes'?'eyes':'brows',node.getMesh().listPrimitives()[0].getMaterial(),
  ]));
  for(const [part,material] of Object.entries(materials))material.setName(part);
  for(const file of body.hair){
    const hair=await io.read(join(input,'hair','Hair_'+file+'.gltf'));
    const node=hair.getRoot().listNodes().find(node=>node.getMesh());
    const hairSkin=node.getSkin();
    assert.deepEqual(hairSkin.listJoints().map(joint=>joint.getName()),names);
    const head=names.indexOf('Head');
    assert.deepEqual(hairSkin.getInverseBindMatrices().getElement(head,[]),skin.getInverseBindMatrices().getElement(head,[]));
    for(const primitive of node.getMesh().listPrimitives()){
      const joints=primitive.getAttribute('JOINTS_0').getArray();
      const weights=primitive.getAttribute('WEIGHTS_0').getArray();
      assert.ok(joints.every((joint,index)=>!weights[index]||joint===head));
    }
    const mesh=copyToDocument(document,hair,[node.getMesh()]).get(node.getMesh());
    for(const primitive of mesh.listPrimitives())primitive.getMaterial().setName('hair');
    parent.addChild(document.createNode('part-'+file).setMesh(mesh).setSkin(skin));
  }
  for(const animation of root.listAnimations())animation.dispose();
  retargetClips(document,source,source.getRoot().listAnimations().map(clip=>clip.getName()));
  for(const material of root.listMaterials()){
    material.setMetallicFactor(0).setRoughnessFactor(.78).setMetallicRoughnessTexture(null);
  }
  await document.transform(prune(),dedup({keepUniqueNames:true}),weld(),
    simplify({simplifier:MeshoptSimplifier,ratio:.42,error:.004}),resample(),prune(),unpartition());
  for(const texture of root.listTextures()){
    let pipeline=sharp(texture.getImage()).resize({width:512,height:512,fit:'inside',withoutEnlargement:true});
    if(texture===materials.skin.getBaseColorTexture()) {
      const {data,info}=await pipeline.removeAlpha().raw().toBuffer({resolveWithObject:true});
      for(let i=0;i<data.length;i+=3) {
        // The Standard body atlas packs warm skin and neutral shorts/top together.
        if(data[i]-data[i+2]<12)continue;
        for(const [channel,reference] of [184,130,92].entries())data[i+channel]=Math.min(255,Math.round(data[i+channel]*230/reference));
      }
      pipeline=sharp(data,{raw:info});
    }
    const isNormal=root.listMaterials().some(material=>material.getNormalTexture()===texture);
    texture.setImage(await (isNormal?pipeline.png():pipeline.webp({quality:84})).toBuffer())
      .setMimeType(isNormal?'image/png':'image/webp');
  }
  await document.transform(dedup({propertyTypes:[PropertyType.TEXTURE]}));
  for(const node of bodyNodes)node.setName(node===main?'body':node.getName()==='Eyes'?'eyes':'brows');
  // Encode palette roles in materials, and selectable part names in nodes.
  catalog.bodies[body.id]={minY,maxY,hair:body.hair.filter(file=>file!=='Beard'),beard:body.hair.includes('Beard')};
  await io.write(join(output,body.id+'.glb'),document);
}
await writeFile(join(output,'appearance.json'),JSON.stringify(catalog,null,2)+'\n');
