import {readFile,writeFile} from 'node:fs/promises';

const directory=new URL('../src/modules/world/data/downtown/',import.meta.url);
const city=JSON.parse(await readFile(new URL('city.json',directory),'utf8'));
const parts={};
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const same=(a,b)=>a[0]===b[0]&&a[1]===b[1];

function mergeConvex(polygons){
  for(let i=0;i<polygons.length;i++)for(let j=i+1;j<polygons.length;j++){
    const a=polygons[i],b=polygons[j];
    let merged;
    for(let u=0;u<a.length&&!merged;u++)for(let v=0;v<b.length&&!merged;v++){
      if(!same(a[u],b[(v+1)%b.length])||!same(a[(u+1)%a.length],b[v]))continue;
      const candidate=Array.from({length:a.length},(_,k)=>a[(u+1+k)%a.length])
        .concat(Array.from({length:b.length-2},(_,k)=>b[(v+2+k)%b.length]));
      if(candidate.every((p,k)=>cross(p,candidate[(k+1)%candidate.length],candidate[(k+2)%candidate.length])>=-1e-8))merged=candidate;
    }
    if(merged){polygons[i]=merged;polygons.splice(j,1);i=-1;break;}
  }
  return polygons;
}

for(const chunk of city.chunks)for(const detail of chunk.details??[]){
  const facade=detail.meshes.find(m=>m.surface.endsWith('-detail'));
  if(!facade)continue;
  const {positions,indices,uvs}=facade;
  const point=i=>[positions[i*3],positions[i*3+2]];
  const edges=new Map();
  for(let i=0;i<positions.length/3-3;i++){
    // Foundation wall quads correspond to the exterior and any interior rings.
    if(!uvs.slice(i*2,i*2+8).every(n=>n===-1))continue;
    const a=point(i),b=point(i+2);
    if(same(a,point(i+1))&&same(b,point(i+3))&&positions[i*3+1]<positions[(i+1)*3+1]&&positions[(i+2)*3+1]>positions[(i+3)*3+1])
      edges.set(a.join(','),b.join(','));
  }
  let rings=0;
  while(edges.size){
    const start=edges.keys().next().value;
    let next=start;
    while(edges.has(next)){
      const current=next;
      next=edges.get(current);
      edges.delete(current);
    }
    if(next===start)rings++;
  }
  if(rings<2)continue;
  const polygons=[];
  for(let i=0;i<indices.length;i+=3){
    const ids=indices.slice(i,i+3);
    if(!ids.every(index=>uvs[index*2]===-2&&uvs[index*2+1]===-2))continue;
    const [a,b,c]=ids.map(point);
    const area=cross(a,b,c);
    if(Math.abs(area)>1e-8)polygons.push(area>0?[a,b,c]:[a,c,b]);
  }
  if(!polygons.length)throw new Error('Missing courtyard roof geometry: '+detail.id);
  parts[detail.id.slice((city.id+'/detail/').length)]=mergeConvex(polygons);
}
await writeFile(new URL('collision-courtyards.json',directory),JSON.stringify(parts)+'\n');
console.log(Object.fromEntries(Object.entries(parts).map(([id,pieces])=>[id,pieces.length])));
