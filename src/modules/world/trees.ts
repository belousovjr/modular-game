import {Color3} from '@babylonjs/core/Maths/math.color.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
import {StandardMaterial} from '@babylonjs/core/Materials/standardMaterial.js';
import {Texture} from '@babylonjs/core/Materials/Textures/texture.js';
import {Mesh} from '@babylonjs/core/Meshes/mesh.js';
import {VertexData} from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type {Scene} from '@babylonjs/core/scene.js';
import type {Scope} from '../../core/modules.ts';
import type {WorldPlacement} from '../world-generation/index.ts';

export function groupTrees(placements:readonly WorldPlacement[]){
  const groups=new Map<string,{trees:WorldPlacement[];bounds:{minX:number;maxX:number;minZ:number;maxZ:number};minY:number;maxY:number}>();
  for(const tree of placements){
    if(tree.templateId!=='city/tree')continue;
    const [x,y,z]=tree.position;
    const key=`${Math.floor(x/64)}/${Math.floor(z/64)}`;
    const radius=tree.parameters.height*.48;
    let group=groups.get(key);
    if(!group){
      group={trees:[],bounds:{minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity},minY:Infinity,maxY:-Infinity};
      groups.set(key,group);
    }
    group.trees.push(tree);
    group.minY=Math.min(group.minY,y);
    group.maxY=Math.max(group.maxY,y+tree.parameters.height);
    const b=group.bounds;
    b.minX=Math.min(b.minX,x-radius);b.maxX=Math.max(b.maxX,x+radius);
    b.minZ=Math.min(b.minZ,z-radius);b.maxZ=Math.max(b.maxZ,z+radius);
  }
  return groups;
}

export function createTreeMaterial(scene:Scene,owner:Scope){
  const texture=new Texture(`${import.meta.env?.BASE_URL??'/'}textures/trees/downtown-atlas.webp`,scene,false,false,Texture.TRILINEAR_SAMPLINGMODE);
  owner.onDispose(()=>texture.dispose());
  texture.hasAlpha=true;
  texture.wrapU=texture.wrapV=Texture.CLAMP_ADDRESSMODE;
  const material=new StandardMaterial('world/tree-atlas',scene);
  owner.onDispose(()=>material.dispose());
  material.diffuseTexture=texture;
  material.useAlphaFromDiffuseTexture=true;
  material.diffuseColor=new Color3(.78,.88,.72);
  material.specularColor=Color3.Black();
  material.transparencyMode=StandardMaterial.MATERIAL_ALPHATEST;
  material.alphaCutOff=.33;
  material.backFaceCulling=false;
  return material;
}

export function treeLodBounds(distance:number,horizontalDistance:number){
  const smooth=(x:number)=>{
    const t=Math.min(1,Math.max(0,x));
    return t*t*(3-2*t);
  };
  const coverage=1-smooth((horizontalDistance-185)/25);
  return {coverage,split:coverage*smooth((distance-32)/28)};
}

export function createTreeBatch(name:string,trees:readonly WorldPlacement[],material:StandardMaterial,owner:Scope,far:boolean){
  const mesh=new Mesh(name,material.getScene());
  owner.onDispose(()=>mesh.dispose());
  const positions:number[]=[],indices:number[]=[],normals:number[]=[],uvs:number[]=[];
  const vertex=(p:Vector3,n:Vector3,u:number,v:number)=>{
    positions.push(p.x,p.y,p.z);
    normals.push(n.x,n.y,n.z);
    uvs.push(u/512,v/256);
  };
  const tube=(base:Vector3,tip:Vector3,radius:number,sides:number)=>{
    const start=positions.length/3;
    const axis=tip.subtract(base).normalize();
    const across=Math.abs(axis.y)>.99?Vector3.Right():Vector3.Cross(Vector3.Up(),axis).normalize();
    const tangent=Vector3.Cross(axis,across).normalize();
    for(let i=0;i<=sides;i++){
      const angle=i/sides*2*Math.PI;
      const normal=across.scale(Math.cos(angle)).add(tangent.scale(Math.sin(angle)));
      vertex(base.add(normal.scale(radius)),normal,483+i/sides*22,234);
      vertex(tip.add(normal.scale(radius*.44)),normal,483+i/sides*22,22);
      if(i===sides)continue;
      const a=start+2*i;
      indices.push(a,a+1,a+2,a+1,a+3,a+2);
    }
  };
  const card=(centre:Vector3,across:Vector3,up:Vector3,shade:Vector3,u0:number,v0:number,u1:number,v1:number)=>{
    const i=positions.length/3;
    vertex(centre.subtract(across).subtract(up),shade,u0,v1);
    vertex(centre.add(across).subtract(up),shade,u1,v1);
    vertex(centre.add(across).add(up),shade,u1,v0);
    vertex(centre.subtract(across).add(up),shade,u0,v0);
    indices.push(i,i+1,i+2,i,i+2,i+3);
  };
  for(const tree of trees){
    const h=tree.parameters.height,[x,y,z]=tree.position,yaw=tree.rotation[1];
    const base=new Vector3(x,y-.07,z);
    tube(base,new Vector3(x,y+h*.72,z),h*.022,far?4:6);
    if(far){
      const centre=new Vector3(x,y+h*.69,z);
      const across=new Vector3(Math.cos(yaw),0,Math.sin(yaw)).scale(h*.37);
      const depth=new Vector3(-across.z,0,across.x);
      const up=new Vector3(0,h*.31,0);
      const normal=Vector3.Up();
      card(centre,across,up,normal,248,16,472,240);
      card(centre,depth,up,normal,248,16,472,240);
      card(centre,across,depth,normal,248,16,472,240);
      continue;
    }
    const core=new Vector3(x,y+h*.55,z);
    for(let cluster=0;cluster<4;cluster++){
      const angle=yaw+cluster*2.399;
      const top=cluster===3;
      const spread=top?.045:.15;
      const centre=new Vector3(x+Math.cos(angle)*h*spread,y+h*(top?.79:.60+cluster*.045),z+Math.sin(angle)*h*spread);
      if(!top)tube(core,centre,h*.009,3);
      const size=h*(top?.46:.48);
      const shade=new Vector3((centre.x-x)*.5,h*.42,(centre.z-z)*.5).normalize();
      for(let plane=0;plane<3;plane++){
        const a=angle+plane*Math.PI/3;
        const across=new Vector3(Math.cos(a),0,Math.sin(a)).scale(size*.5);
        const up=new Vector3(-Math.sin(a)*.44,.90,Math.cos(a)*.44).scale(size*.47);
        card(centre,across,up,shade,16,24,240,232);
      }
    }
  }
  const data=new VertexData();
  data.positions=positions;data.indices=indices;data.normals=normals;data.uvs=uvs;
  data.applyToMesh(mesh);
  mesh.material=material;
  mesh.isPickable=false;
  // shortcut: cutout vegetation receives shadows, revisit casting when static cutouts can reuse shadow maps.
  mesh.metadata={shadowCaster:false,vegetation:true,vegetationLod:far?'far':'near'};
  mesh.setEnabled(false);
  mesh.freezeWorldMatrix();
  return mesh;
}
