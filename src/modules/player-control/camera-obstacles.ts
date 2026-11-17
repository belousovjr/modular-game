import type {CollisionBox} from '../world/index.ts';

type Point = {readonly x:number;readonly y:number;readonly z:number};

export function cameraObstacleFraction(target:Point, arm:Point, radius:number, blockers:readonly CollisionBox[]) {
  const padding=.2;
  const minX=Math.min(target.x,target.x+arm.x)-padding;
  const maxX=Math.max(target.x,target.x+arm.x)+padding;
  const minZ=Math.min(target.z,target.z+arm.z)-padding;
  const maxZ=Math.max(target.z,target.z+arm.z)+padding;
  let fraction=1;
  for(const box of blockers){
    if(box.maxX<minX||box.minX>maxX||box.maxZ<minZ||box.minZ>maxZ)continue;
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
