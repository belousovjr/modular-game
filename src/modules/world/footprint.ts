import type {CitySource} from '../world-generation/index.ts';

function insideRing(x:number,z:number,ring:readonly (readonly number[])[]) {
  let inside=false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [ax,az]=ring[j], [bx,bz]=ring[i];
    if ((az>z)!==(bz>z) && x<ax+(bx-ax)*(z-az)/(bz-az)) inside=!inside;
  }
  return inside;
}

export function containsBuildingFootprint(building:CitySource['colliders'][number],x:number,z:number) {
  return x>=building.minX && x<=building.maxX && z>=building.minZ && z<=building.maxZ &&
    (building.parts ? building.parts.some(part=>insideRing(x,z,part)) : insideRing(x,z,building.outline));
}
