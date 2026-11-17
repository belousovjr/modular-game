import type {CollisionWorld} from '../world/index.ts';

type Point = {readonly x:number;readonly y:number;readonly z:number};

// Index static terrain once; camera movement only visits cells along its short orbit.
export function createCameraGroundSweep(world:CollisionWorld) {
  const cells=new Map<string,(readonly number[])[]>();
  const add=(p:readonly number[])=>{
    for(let x=Math.floor(Math.min(p[0],p[3],p[6])/16);x<=Math.floor(Math.max(p[0],p[3],p[6])/16);x++)
      for(let z=Math.floor(Math.min(p[2],p[5],p[8])/16);z<=Math.floor(Math.max(p[2],p[5],p[8])/16);z++) {
        const key=`${x}/${z}`,cell=cells.get(key);if(cell)cell.push(p);else cells.set(key,[p]);
      }
  };
  for(const p of world.triangles??[])add(p);
  for(const f of world.floors){
    const y=(x:number)=>world.baseHeight+world.slopeX*x+f.elevation;
    add([f.minX,y(f.minX),f.minZ,f.maxX,y(f.maxX),f.minZ,f.maxX,y(f.maxX),f.maxZ]);
    add([f.minX,y(f.minX),f.minZ,f.maxX,y(f.maxX),f.maxZ,f.minX,y(f.minX),f.maxZ]);
  }
  return (origin:Point,delta:Point)=>{
    let fraction=1;
    // shortcut: plane clearance does not sweep triangle edges, revisit if sharp terrain ledges clip.
    const clearance=.22;
    const baseStart=origin.y-world.baseHeight-world.slopeX*origin.x-clearance*Math.hypot(1,world.slopeX);
    const baseDirection=delta.y-world.slopeX*delta.x;
    if(baseStart>=0&&baseDirection<0)fraction=Math.min(fraction,baseStart/-baseDirection);
    const visited=new Set<readonly number[]>();
    for(let x=Math.floor(Math.min(origin.x,origin.x+delta.x)/16);x<=Math.floor(Math.max(origin.x,origin.x+delta.x)/16);x++)
      for(let z=Math.floor(Math.min(origin.z,origin.z+delta.z)/16);z<=Math.floor(Math.max(origin.z,origin.z+delta.z)/16);z++)
        for(const p of cells.get(`${x}/${z}`)??[]) {
          if(visited.has(p))continue;visited.add(p);
          const ax=p[3]-p[0],az=p[5]-p[2],bx=p[6]-p[0],bz=p[8]-p[2],den=ax*bz-bx*az;
          if(Math.abs(den)<1e-10)continue;
          const slopeX=((p[4]-p[1])*bz-(p[7]-p[1])*az)/den;
          const slopeZ=(ax*(p[7]-p[1])-bx*(p[4]-p[1]))/den;
          const start=origin.y-p[1]-slopeX*(origin.x-p[0])-slopeZ*(origin.z-p[2])-clearance*Math.hypot(1,slopeX,slopeZ);
          const direction=delta.y-slopeX*delta.x-slopeZ*delta.z;
          if(start<0||direction>=0)continue;
          const t=start/-direction;if(t<0||t>=fraction)continue;
          const dx=origin.x+delta.x*t-p[0],dz=origin.z+delta.z*t-p[2];
          const u=(dx*bz-bx*dz)/den,v=(ax*dz-dx*az)/den;
          if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)fraction=t;
        }
    return fraction;
  };
}
