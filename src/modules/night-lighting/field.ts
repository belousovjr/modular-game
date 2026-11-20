import type {StreetLightAnchor,CollisionBox} from '../world/index.ts';
export interface FieldBounds{readonly minX:number;readonly maxX:number;readonly minZ:number;readonly maxZ:number}
export function bakeNightField(lamps:readonly StreetLightAnchor[],buildings:readonly CollisionBox[],bounds:FieldBounds,phase:(x:number,z:number)=>number,size=1024){
  if(!Number.isSafeInteger(size)||size<16||size>2048||bounds.maxX<=bounds.minX||bounds.maxZ<=bounds.minZ)throw new Error('Invalid night field bounds/size');
  const values=new Float32Array(size*size*8),sx=(bounds.maxX-bounds.minX)/size,sz=(bounds.maxZ-bounds.minZ)/size;
  function paint(minX:number,minZ:number,maxX:number,maxZ:number,channel:number,value:(x:number,z:number)=>number){
    for(let j=Math.max(0,Math.floor((minZ-bounds.minZ)/sz));j<Math.min(size,Math.ceil((maxZ-bounds.minZ)/sz));j++)
      for(let i=Math.max(0,Math.floor((minX-bounds.minX)/sx));i<Math.min(size,Math.ceil((maxX-bounds.minX)/sx));i++)values[(j*size+i)*4+channel]+=value(bounds.minX+(i+.5)*sx,bounds.minZ+(j+.5)*sz);
  }
  function pool(x:number,z:number,rx:number,rz:number,channel:number,gain:number,distant=false){paint(x-rx,z-rz,x+rx,z+rz,channel+(distant?size*size*4:0),(px,pz)=>{const d=((px-x)/rx)**2+((pz-z)/rz)**2;return d<1?gain*(Math.exp(-3*d)-Math.exp(-3))/(1-Math.exp(-3)):0;});}
  for(const lamp of lamps)pool(lamp.x,lamp.z,11,11,phase(lamp.x,lamp.z),.72);
  const unused=new Set(lamps),groups:StreetLightAnchor[][]=[];
  for(const seed of lamps){
    if(!unused.has(seed))continue;
    const group=lamps.filter(p=>unused.has(p)&&p.street===seed.street&&Math.hypot(p.x-seed.x,p.z-seed.z)<=180).sort((a,b)=>Math.hypot(a.x-seed.x,a.z-seed.z)-Math.hypot(b.x-seed.x,b.z-seed.z)).slice(0,10);
    for(const p of group)unused.delete(p);groups.push(group);
    const x=group.reduce((sum,p)=>sum+p.x,0)/group.length,z=group.reduce((sum,p)=>sum+p.z,0)/group.length;
    const rx=Math.max(28,...group.map(p=>Math.abs(p.x-x)+32))*1.3,rz=Math.max(22,...group.map(p=>Math.abs(p.z-z)+24))*1.2;
    const counts = [0,0,0];
    for (const lamp of group) counts[phase(lamp.x,lamp.z)]++;
    for (const [channel, count] of counts.entries()) if (count) {
      pool(x,z,rx,rz,channel,.22*Math.sqrt(group.length/4)*count/group.length,true);
    }
  }
  let buildingCount=0;
  for(const building of buildings){
    const outline=building.outline;if(!outline||outline.length<3||building.maxY-building.minY<5)continue;buildingCount++;
    paint(building.minX-14,building.minZ-14,building.maxX+14,building.maxZ+14,3,(x,z)=>{
      let distance=Infinity;
      for(let i=0;i<outline.length;i++){
        const a=outline[i],b=outline[(i+1)%outline.length],dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1)));
        distance=Math.min(distance,Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz));
      }
      return Math.exp(-((distance/6)**2))*.32;
    });
  }
  const data = new Uint8Array(values.length);
  const layer = size*size*4;
  for (let i=0;i<layer;i+=4) {
    values[i+layer+3] = values[i+3];
  }
  for (let i=0;i<data.length;i++) data[i] = Math.round(Math.min(1,values[i])*255);
  return {data,size,groups:groups.length,maxGroup:Math.max(0,...groups.map(g=>g.length)),lamps:lamps.length,buildings:buildingCount};
}
