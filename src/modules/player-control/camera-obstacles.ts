import type {CollisionBox} from '../world/index.ts';
import type {InteriorCollisionBox,InteriorQueryBounds} from '../building-interiors/index.ts';

type Point = {readonly x:number;readonly y:number;readonly z:number};
const CLEARANCE=.2;
const CELL=32;

export function createCameraObstacleSweep(blockers:readonly CollisionBox[],
  local?: (bounds:InteriorQueryBounds)=>readonly InteriorCollisionBox[]) {
  const grid=new Map<string,number[]>(),large:number[]=[];
  const cell=(value:number)=>Math.floor(value/CELL);
  for(const [index,b] of blockers.entries()){
    const x0=cell(b.minX),x1=cell(b.maxX),z0=cell(b.minZ),z1=cell(b.maxZ);
    if(![x0,x1,z0,z1].every(Number.isSafeInteger)||(x1-x0+1)*(z1-z0+1)>256){large.push(index);continue;}
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){
      const key=`${x}/${z}`,entries=grid.get(key);
      if(entries)entries.push(index);else grid.set(key,[index]);
    }
  }
  return (target:Point,arm:Point,radius:number)=>{
    const x0=cell(Math.min(target.x,target.x+arm.x)-CLEARANCE),x1=cell(Math.max(target.x,target.x+arm.x)+CLEARANCE);
    const z0=cell(Math.min(target.z,target.z+arm.z)-CLEARANCE),z1=cell(Math.max(target.z,target.z+arm.z)+CLEARANCE);
    const selected=new Set(large);
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++)for(const i of grid.get(`${x}/${z}`)??[])selected.add(i);
    const candidates=[...selected].sort((a,b)=>a-b).map(i=>blockers[i]);
    const limit=cameraObstacleFraction(target,arm,radius,candidates);
    if (!local||limit<=0) return limit;
    const endX=target.x+arm.x*limit,endY=target.y+arm.y*limit,endZ=target.z+arm.z*limit;
    const interior=local({
      minX:Math.min(target.x,endX)-CLEARANCE,maxX:Math.max(target.x,endX)+CLEARANCE,
      minZ:Math.min(target.z,endZ)-CLEARANCE,maxZ:Math.max(target.z,endZ)+CLEARANCE,
      minY:Math.min(target.y,endY)-CLEARANCE,maxY:Math.max(target.y,endY)+CLEARANCE,
    });
    return cameraObstacleFraction(target,arm,radius,interior,limit);
  };
}

function outlineEntry(target:Point,arm:Point,box:InteriorCollisionBox,outline:readonly (readonly number[])[],limit:number){
  let first=0,last=limit;
  let originY=target.y,deltaY=arm.y,minY=box.minY,maxY=box.maxY,padding=CLEARANCE;
  const slope=box.slope;
  if(slope){
    const lengthSquared=slope.dx*slope.dx+slope.dz*slope.dz, rise=slope.low1-slope.low0;
    originY-=rise*((target.x-slope.x)*slope.dx+(target.z-slope.z)*slope.dz)/lengthSquared;
    deltaY-=rise*(arm.x*slope.dx+arm.z*slope.dz)/lengthSquared;
    minY=slope.low0;maxY=slope.high0;
    padding*=Math.hypot(1,rise/Math.sqrt(lengthSquared));
  }
  if((originY<=minY&&deltaY<=0)||(originY>=maxY&&deltaY>=0))return null;
  if(Math.abs(deltaY)<1e-9){
    if(originY<minY-padding||originY>maxY+padding)return null;
  }else{
    const a=(minY-padding-originY)/deltaY,b=(maxY+padding-originY)/deltaY;
    first=Math.max(first,Math.min(a,b));last=Math.min(last,Math.max(a,b));
    if(first>last)return null;
  }
  const px=target.x+arm.x*first,pz=target.z+arm.z*first;
  let inside=false,hit:number|null=null;
  for(let i=0,j=outline.length-1;i<outline.length;j=i++){
    const a=outline[j],b=outline[i];
    const dx=b[0]-a[0],dz=b[1]-a[1];
    if((a[1]>pz)!==(b[1]>pz)&&px<a[0]+dx*(pz-a[1])/dz)inside=!inside;
    const length=Math.hypot(dx,dz);
    if(length<1e-8)continue;
    const ux=dx/length,uz=dz/length,x=target.x-a[0],z=target.z-a[1];
    const side=x*uz-z*ux,across=arm.x*uz-arm.z*ux;
    // Let a camera already touching this edge move along it or away from it.
    if((side>1e-8&&across>=-1e-9)||(side< -1e-8&&across<=1e-9))continue;
    let enter=first,exit=hit??last;
    // A padded strip covers each edge, including a conservative corner margin.
    for(const [start,direction,min,max] of [
      [side,across,-CLEARANCE,CLEARANCE],
      [x*ux+z*uz,arm.x*ux+arm.z*uz,-CLEARANCE,length+CLEARANCE],
    ]){
      if(Math.abs(direction)<1e-9){
        if(start<min||start>max){exit=-1;break;}
        continue;
      }
      const from=(min-start)/direction,to=(max-start)/direction;
      enter=Math.max(enter,Math.min(from,to));exit=Math.min(exit,Math.max(from,to));
      if(enter>exit)break;
    }
    if(enter<=exit)hit=enter;
  }
  return inside?first:hit;
}

export function cameraObstacleFraction(target:Point, arm:Point, radius:number, blockers:readonly InteriorCollisionBox[], limit=1) {
  const padding=CLEARANCE;
  const minX=Math.min(target.x,target.x+arm.x)-padding;
  const maxX=Math.max(target.x,target.x+arm.x)+padding;
  const minZ=Math.min(target.z,target.z+arm.z)-padding;
  const maxZ=Math.max(target.z,target.z+arm.z)+padding;
  let fraction=limit;
  for(const box of blockers){
    if(box.maxX<minX||box.minX>maxX||box.maxZ<minZ||box.minZ>maxZ)continue;
    if(box.outline){
      const hit=outlineEntry(target,arm,box,box.outline,fraction);
      if(hit!==null)fraction=Math.max(0,hit-.02/radius);
      continue;
    }
    let enter=0,exit=fraction;
    // If the target is already inside the padding, an outward or tangential ray can leave it.
    for(const [start,direction,min,max] of [
      [target.x,arm.x,box.minX,box.maxX],
      [target.y,arm.y,box.minY,box.maxY],
      [target.z,arm.z,box.minZ,box.maxZ],
    ]){
      if((start<=min&&direction<=0)||(start>=max&&direction>=0)){exit=-1;break;}
      if(Math.abs(direction)<1e-9){
        if(start<min-padding||start>max+padding){exit=-1;break;}
        continue;
      }
      const a=(min-padding-start)/direction,b=(max+padding-start)/direction;
      enter=Math.max(enter,Math.min(a,b));
      exit=Math.min(exit,Math.max(a,b));
      if(enter>exit)break;
    }
    if(enter<=exit)fraction=Math.max(0,enter-.02/radius);
  }
  return fraction;
}

export function recoverCameraRadius(previous:number, safe:number, deltaMs:number) {
  if(safe<=previous||safe-previous<.01)return safe;
  return safe-(safe-previous)*Math.exp(-Math.max(0,deltaMs)/95);
}
