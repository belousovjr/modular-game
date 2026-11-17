import {readFile, writeFile} from 'node:fs/promises';

const folder=new URL('../src/modules/world/data/downtown/',import.meta.url);
const city=JSON.parse(await readFile(new URL('city.json',folder),'utf8'));
const cells=new Map();
const cell=(x,z)=>`${Math.floor(x/32)}/${Math.floor(z/32)}`;
for(const {meshes} of city.chunks)for(const {surface,positions,indices} of meshes){
  if(!['terrain','sidewalk','road'].includes(surface))continue;
  for(let i=0;i<indices.length;i+=3){
    const vertices=indices.slice(i,i+3).map(index=>positions.slice(index*3,index*3+3));
    const [a,b,c]=vertices;
    const area=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);
    if(Math.abs(area)<1e-7)continue;
    const xs=vertices.map(v=>v[0]),zs=vertices.map(v=>v[2]);
    for(let x=Math.floor(Math.min(...xs)/32);x<=Math.floor(Math.max(...xs)/32);x++){
      for(let z=Math.floor(Math.min(...zs)/32);z<=Math.floor(Math.max(...zs)/32);z++){
        const key=`${x}/${z}`;
        if(!cells.has(key))cells.set(key,[]);
        cells.get(key).push({surface,a,b,c,area});
      }
    }
  }
}

function height(x,z,surface){
  for(const {surface:type,a,b,c,area} of cells.get(cell(x,z))??[]){
    if(type!==surface)continue;
    const dx=x-a[0],dz=z-a[2];
    const u=(dx*(c[2]-a[2])-dz*(c[0]-a[0]))/area;
    const v=((b[0]-a[0])*dz-(b[2]-a[2])*dx)/area;
    if(u>=-1e-8&&v>=-1e-8&&u+v<=1+1e-8)return a[1]+u*(b[1]-a[1])+v*(c[1]-a[1]);
  }
}

const trees=[];
const props=city.placements.filter(p=>p.templateId==='world/lamp'||p.templateId==='city/signal');
const seed=(x,z)=>(Math.imul(x,73856093)^Math.imul(z,19349663))>>>0;
const snap=(value,step)=>Math.round(value/step)*step;
function tree(x,y,z,kind){
  const hash=seed(x,z);
  const height=(kind==='park'?7:5.5)+(hash%11)*.25;
  trees.push({key:`authored/tree/${kind}/${x}/${z}`,templateId:'city/tree',parameters:{height},
    position:[x,snap(y,.0001),z],rotation:[0,snap((hash%24)*Math.PI/12,.00000001),0]});
}
for(const p of city.placements.filter(p=>p.templateId==='city/planter')){
  const [x,y,z]=p.position;
  tree(x,y+.5,z,'planter');
}
for(const [surface,kind,step,clearance] of [['terrain','park',22,2.5],['sidewalk','street',20,1]]){
  for(let gx=city.bounds.minX+step;gx<city.bounds.maxX;gx+=step){
    for(let gz=city.bounds.minZ+step;gz<city.bounds.maxZ;gz+=step){
      const hash=seed(gx,gz);
      const x=gx+(hash%7)-3,z=gz+((hash>>>8)%7)-3;
      if(x>=0&&x<=92&&z>=-80&&z<=-38)continue;
      const y=height(x,z,surface);
      if(y===undefined||height(x,z,'road')!==undefined)continue;
      if(![[-1,0],[1,0],[0,-1],[0,1]].every(([dx,dz])=>height(x+dx*clearance,z+dz*clearance,surface)!==undefined))continue;
      if(city.colliders.some(b=>x>b.minX-2.2&&x<b.maxX+2.2&&z>b.minZ-2.2&&z<b.maxZ+2.2))continue;
      if(props.some(p=>Math.hypot(p.position[0]-x,p.position[2]-z)<4))continue;
      if(trees.some(p=>Math.hypot(p.position[0]-x,p.position[2]-z)<7))continue;
      tree(x,y,z,kind);
    }
  }
}
await writeFile(new URL('trees.json',folder),'['+trees.map(t=>JSON.stringify(t)).join(',\n')+']'+'\n');
console.log(trees.length,'trees');
