import type { BuildingProfile, BuildingInteriorSource, CollisionBox, BuildingDoor } from '../world/headless.ts';

export type Point = readonly [number, number];
type Rectangle = {minX:number; minZ:number; maxX:number; maxZ:number};
export type Opening = Rectangle & {kind:'elevator'|'staircase'; front?:number; stairFront?:number};

export function openingCorners({minX,minZ,maxX,maxZ}: Rectangle): Point[] {
  return [[minX,minZ],[maxX,minZ],[maxX,maxZ],[minX,maxZ]];
}

function overlaps(a: Rectangle, b: Rectangle) {
  return a.minX<b.maxX && a.maxX>b.minX && a.minZ<b.maxZ && a.maxZ>b.minZ;
}
type Side = readonly [axis:0|1, limit:number, sign:number];

function sides(box: Rectangle): Side[] {
  return [[0,box.minX,1],[0,box.maxX,-1],[1,box.minZ,1],[1,box.maxZ,-1]];
}

function split(polygon: readonly Point[], [axis,limit,sign]: Side): [Point[],Point[]] {
  const inside: Point[] = [], outside: Point[] = [];
  let a = polygon[polygon.length-1];
  for (const b of polygon) {
    const da = (a[axis]-limit)*sign, db = (b[axis]-limit)*sign;
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const t = da/(da-db);
      const intersection: Point = axis===0 ? [limit,a[1]+(b[1]-a[1])*t] : [a[0]+(b[0]-a[0])*t,limit];
      inside.push(intersection);
      outside.push(intersection);
    }
    if (db >= 0) inside.push(b);
    if (db <= 0) outside.push(b);
    a = b;
  }
  return [inside,outside];
}

function crossesBox(a: Point, b: Point, planes: readonly Side[]) {
  let from = 0, to = 1;
  for (const [axis,limit,sign] of planes) {
    const start = (a[axis]-limit)*sign, delta = (b[axis]-a[axis])*sign;
    if (delta === 0) {
      if (start < 0) return false;
    } else if (delta > 0) from = Math.max(from,-start/delta);
    else to = Math.min(to,-start/delta);
    if (to < from) return false;
  }
  return true;
}

export function floorOpenings(profile: BuildingProfile, footprint: readonly Point[], triangles: readonly number[], lobbyPass = 0): Opening[] {
  const boundary = new Map<string, [Point,Point]>();
  for (let i=0; i<triangles.length; i+=3) {
    for (let j=0; j<3; j++) {
      const a=triangles[i+j], b=triangles[i+(j+1)%3];
      const key=a<b?`${a}/${b}`:`${b}/${a}`;
      if (!boundary.delete(key)) boundary.set(key,[footprint[a],footprint[b]]);
    }
  }
  const edges = [...boundary.values()];
  const openings: Opening[] = [];
  if (!edges.length) return openings;
  let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
  for (const [a] of edges) {
    minX=Math.min(minX,a[0]); minZ=Math.min(minZ,a[1]);
    maxX=Math.max(maxX,a[0]); maxZ=Math.max(maxZ,a[1]);
  }
  const [entryX,entryZ] = profile.entrance.center;
  const entryWall=profile.facades[profile.entrance.wallIndex];
  const dx=entryWall.end[0]-entryWall.start[0], dz=entryWall.end[1]-entryWall.start[1];
  const span=Math.hypot(dx,dz);
  const tx=dx/span, tz=dz/span;
  const depthAt = (x:number,z:number) => (x-entryX)*tz-(z-entryZ)*tx;
  const floorDepth=Math.max(0,...edges.map(([a])=>depthAt(a[0],a[1])));
  const lobbyScales=[1,.8,.6,.4,.2,0,0];
  const backFirst=lobbyPass<lobbyScales.length-1;
  const lobbyDepth=Math.min(floorDepth*.65,Math.max(8,floorDepth*.45))*lobbyScales[lobbyPass];
  const passageHalfWidth=profile.entrance.width/2+.5;
  function blocksEntrance(box: Rectangle, clearance: number) {
    const x=(box.minX+box.maxX)/2-entryX, z=(box.minZ+box.maxZ)/2-entryZ;
    const halfX=(box.maxX-box.minX)/2, halfZ=(box.maxZ-box.minZ)/2;
    const across=x*tx+z*tz, depth=x*tz-z*tx;
    const acrossRadius=halfX*Math.abs(tx)+halfZ*Math.abs(tz);
    const depthRadius=halfX*Math.abs(tz)+halfZ*Math.abs(tx);
    const sideGap=Math.max(0,Math.abs(across)-acrossRadius-passageHalfWidth);
    const depthGap=Math.max(0,Math.abs(depth)-depthRadius);
    return (lobbyDepth>0 && depth-depthRadius<lobbyDepth) ||
      (sideGap===0 && depth+depthRadius>0 && depth-depthRadius<3.5) ||
      Math.hypot(sideGap,depthGap)<clearance;
  }

  function eligibleCenter(x:number,z:number) {
    if (Math.hypot(x-entryX,z-entryZ)<3) return false;
    let inside=false;
    for (const [[ax,az],[bx,bz]] of edges) {
      if ((az>z)!==(bz>z) && x<ax+(bx-ax)*(z-az)/(bz-az)) inside=!inside;
    }
    return inside;
  }
  const candidates: Point[] = [];
  const step = Math.min(maxX-minX,maxZ-minZ) < 12 ? .5 : 1;
  for (let z=minZ+step/2; z<maxZ; z+=step) {
    for (let x=minX+step/2; x<maxX; x+=step) {
      if (eligibleCenter(x,z)) candidates.push([x,z]);
    }
  }
  candidates.sort(([ax,az],[bx,bz])=>backFirst ? depthAt(bx,bz)-depthAt(ax,az) :
    Math.hypot(ax-entryX,az-entryZ)-Math.hypot(bx-entryX,bz-entryZ));

  const landings: Rectangle[] = [];
  function blocked(box: Rectangle) {
    const planes=sides(box);
    return edges.some(([a,b])=>crossesBox(a,b,planes));
  }
  function viewFrom([x,z]: Point, front: number) {
    const across = front%2===0 ? 0 : 1;
    const facing = 1-across;
    const sign = front===1 || front===2 ? 1 : -1;
    const origin = [x,z];
    let distance = Infinity, window = false;
    for (const {start,end,windowColumns} of profile.facades) {
      const span = end[across]-start[across];
      if (span===0) continue;
      const t=(origin[across]-start[across])/span;
      if (t<0 || t>1) continue;
      const hit=sign*(start[facing]+t*(end[facing]-start[facing])-origin[facing]);
      if (hit<=0 || hit>=distance) continue;
      distance=hit;
      const cell=t*windowColumns;
      window=windowColumns>0 && Math.abs(cell-Math.floor(cell)-.5)<.4;
    }
    return {distance, nearbyWindow:window && distance<6};
  }
  function freeLandings(box: Opening, depth: number, acrossStairs=false) {
    const cx=(box.minX+box.maxX)/2, cz=(box.minZ+box.maxZ)/2;
    const halfX=acrossStairs ? (box.maxX-box.minX)/2-.10 : .5;
    const halfZ=acrossStairs ? (box.maxZ-box.minZ)/2-.10 : .5;
    const choices = [
      {minX:cx-halfX,maxX:cx+halfX,minZ:box.minZ-depth,maxZ:box.minZ},
      {minX:box.maxX,maxX:box.maxX+depth,minZ:cz-halfZ,maxZ:cz+halfZ},
      {minX:cx-halfX,maxX:cx+halfX,minZ:box.maxZ,maxZ:box.maxZ+depth},
      {minX:box.minX-depth,maxX:box.minX,minZ:cz-halfZ,maxZ:cz+halfZ},
    ];
    return choices.map((landing,front)=>({landing,front}))
      .filter(({landing})=>!blocked(landing) && !openings.some(other=>overlaps(landing,other)));
  }
  function elevatorLanding(box: Opening, rowFront?:number) {
    const center: Point = [(box.minX+box.maxX)/2,(box.minZ+box.maxZ)/2];
    // Includes the inset facade's 25 cm thickness.
    const available = freeLandings(box,1.15)
      .map(choice=>({...choice, view:viewFrom(center,choice.front)}))
      .sort((a,b)=>Number(a.view.nearbyWindow)-Number(b.view.nearbyWindow) || b.view.distance-a.view.distance);
    const best=available[0];
    return rowFront===undefined ? best :
      available.find(choice=>choice.front===rowFront && choice.view.nearbyWindow===best?.view.nearbyWindow);
  }
  function stairLanding(box: Opening) {
    const distance = (landing:Rectangle) =>
      Math.hypot((landing.minX+landing.maxX)/2-entryX,(landing.minZ+landing.maxZ)/2-entryZ);
    for (const depth of [2.5,1.5,1.15]) {
      const longZ=box.maxZ-box.minZ>=box.maxX-box.minX;
      const alongRun=(front:number)=>(front%2===0)===longZ;
      const approach=freeLandings(box,depth,backFirst).sort((a,b)=>
        (backFirst ? Number(alongRun(b.front))-Number(alongRun(a.front)) : 0) || distance(a.landing)-distance(b.landing))[0];
      if (approach) return approach;
    }
  }
  function place(kind: Opening['kind'], sizes: readonly Point[], centers: readonly Point[], rowFront?:number, entryClearance=0) {
    // shortcut: use compact reservations in tight footprints until actual circulation models are available.
    for (const [halfX,halfZ] of sizes) {
      for (const [x,z] of centers) {
        const box: Opening={kind,minX:x-halfX,minZ:z-halfZ,maxX:x+halfX,maxZ:z+halfZ};
        const margin=.4;
        const padded={kind,minX:box.minX-margin,minZ:box.minZ-margin,maxX:box.maxX+margin,maxZ:box.maxZ+margin};
        if (blocksEntrance(box,entryClearance) || openings.some(o=>overlaps(padded,o)) || landings.some(o=>overlaps(box,o)) || blocked(padded)) continue;
        if (kind==='elevator') {
          const access=elevatorLanding(box,rowFront);
          if (!access) continue;
          box.front=access.front;
          landings.push(access.landing);
        } else {
          const approach=stairLanding(box);
          if (!approach) continue;
          box.stairFront=approach.front;
          landings.push(approach.landing);
        }
        openings.push(box);
        return box;
      }
    }
  }

  const stairSizes: Point[] = [[1.15,2.3],[2.3,1.15],[.85,1.5],[1.5,.85],[.65,1],[1,.65]];
  if (backFirst && Math.abs(tx)>Math.abs(tz)) {
    // Keep the long side parallel to the entrance wall where possible.
    for (let i=0;i<stairSizes.length;i+=2) [stairSizes[i],stairSizes[i+1]]=[stairSizes[i+1],stairSizes[i]];
  }
  const entryClearance = lobbyDepth>0 ? Math.max(3,lobbyDepth) : 0;
  for (let i=0;i<profile.staircaseCount;i++) {
    const first=openings[0];
    let centers=candidates;
    if (first) {
      const x=(first.minX+first.maxX)/2, z=(first.minZ+first.maxZ)/2;
      const distance=([px,pz]:Point)=>Math.hypot(px-x,pz-z);
      centers=[...candidates].sort((a,b)=>distance(b)-distance(a));
    }
    place('staircase',stairSizes,centers,undefined,Math.max(2.5,entryClearance));
  }

  const stairCount=openings.length;
  const stairLandings=landings.length;
  const shaftSizes: Point[] = [[.95,.95],[.7,.7]];
  function finish() {
    if (backFirst && openings.length<profile.staircaseCount+profile.elevatorCount) {
      // shortcut: release some lobby space in tight footprints until actual floor plans exist.
      return floorOpenings(profile,footprint,triangles,lobbyPass+1);
    }
    return openings;
  }
  if (profile.elevatorCount===0) return finish();

  // Try the corners of the interior bounds first. Every reservation still has to fit the actual footprint.
  const corners = candidates.map(point=>({
    point, score: Math.min(point[0]-minX,maxX-point[0])+Math.min(point[1]-minZ,maxZ-point[1]),
  })).sort((a,b)=>a.score-b.score).map(({point})=>point);
  const rows: Opening[][] = [];
  for (let i=0;i<profile.elevatorCount;i++) {
    let next: Opening | undefined;
    for (const row of rows) {
      if (row.length>=4) continue;
      const first=row[0];
      const front=first.front;
      const alongX=front===0 || front===2;
      const edge=(box:Opening)=>alongX ? box.minX : box.minZ;
      const lastEdge=(box:Opening)=>alongX ? box.maxX : box.maxZ;
      const low=Math.min(...row.map(edge)), high=Math.max(...row.map(lastEdge));
      const cross=alongX ? (first.minZ+first.maxZ)/2 : (first.minX+first.maxX)/2;
      const half=(first.maxX-first.minX)/2;
      const rowCenters: Point[] = [];
      // Snap the gap to the placement grid so the shafts share the same facade line.
      const spacing=Math.ceil((2*half+.400001)/step)*step;
      for (const along of [high-half+spacing,low+half-spacing]) {
        rowCenters.push(alongX?[along,cross]:[cross,along]);
      }
      const reserved = rowCenters.filter(([x,z])=>eligibleCenter(x,z));
      next=place('elevator',[[half,half]],reserved,front,entryClearance);
      if (next) {
        row.push(next);
        break;
      }
    }
    if (next) continue;
    const separated = corners.filter(([x,z])=>rows.every(([first])=>
      Math.hypot(x-(first.minX+first.maxX)/2,z-(first.minZ+first.maxZ)/2)>=6));
    const anchor=place('elevator',shaftSizes,separated,undefined,entryClearance) ?? place('elevator',shaftSizes,corners,undefined,entryClearance);
    if (!anchor) break;
    rows.push([anchor]);
  }
  if (openings.length-stairCount<profile.elevatorCount) {
    // Keep the staircase reservations and recover the configured capacity in irregular footprints.
    openings.length=stairCount;
    landings.length=stairLandings;
    for (let i=0;i<profile.elevatorCount;i++) place('elevator',shaftSizes,candidates,undefined,entryClearance);
  }
  return finish();
}

export function cutFloor(footprint: readonly Point[], triangles: readonly number[], openings: readonly Opening[]) {
  let polygons: Point[][] = [];
  for (let i=0; i<triangles.length; i+=3) polygons.push(triangles.slice(i,i+3).map(index=>footprint[index]));
  for (const opening of openings) {
    const pieces: Point[][] = [];
    const planes = sides(opening);
    for (const polygon of polygons) {
      if (!planes.every(([axis,limit,sign])=>polygon.some(point=>(point[axis]-limit)*sign>0))) {
        pieces.push(polygon);
        continue;
      }
      let inside=polygon;
      for (const side of planes) {
        const [remaining,outside] = split(inside,side);
        if (outside.length>=3) pieces.push(outside);
        if (remaining.length<3) break;
        inside=remaining;
      }
    }
    polygons=pieces;
  }
  const cut: Point[] = [];
  for (const polygon of polygons) {
    const [a] = polygon;
    for (let i=1; i+1<polygon.length; i++) {
      const b=polygon[i], c=polygon[i+1];
      if (Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))>1e-8) cut.push(a,b,c);
    }
  }
  return cut;
}


type Vertex = readonly [across:number,height:number,inward:number];
type StairCollision = CollisionBox & {slope?: {
  x:number;z:number;dx:number;dz:number;
  low0:number;low1:number;high0:number;high1:number;
}};

export function buildStairs(profile:BuildingProfile, openings:readonly Opening[], low:number, high:number, collision?:StairCollision[]) {
  const steps={positions:[] as number[],indices:[] as number[]};
  const rails={positions:[] as number[],indices:[] as number[],uvs:[] as number[]};
  const [ox,,oz]=profile.origin;
  const cos=Math.cos(profile.yaw), sin=Math.sin(profile.yaw);
  for (const opening of openings) {
    const front=opening.stairFront;
    if (front===undefined || high<=low) continue;
    const corners=openingCorners(opening), start=corners[front], end=corners[(front+1)%4];
    const width=Math.hypot(end[0]-start[0],end[1]-start[1]);
    const length=front%2===0 ? opening.maxZ-opening.minZ : opening.maxX-opening.minX;
    const tx=(end[0]-start[0])/width, tz=(end[1]-start[1])/width;
    function face(target:typeof steps | typeof rails, points:readonly Vertex[]) {
      const first=target.positions.length/3;
      for (const [u,y,d] of points) {
        const x=start[0]+tx*u-tz*d, z=start[1]+tz*u+tx*d;
        target.positions.push(ox+x*cos+z*sin,y,oz-x*sin+z*cos);
      }
      target.indices.push(first,first+1,first+2,first,first+2,first+3);
      if ('uvs' in target) {
        const [p,q,r]=points;
        const w=Math.hypot(q[0]-p[0],q[1]-p[1],q[2]-p[2])/2;
        const h=Math.hypot(r[0]-q[0],r[1]-q[1],r[2]-q[2])/2;
        target.uvs.push(0,0,w,0,w,h,0,h);
      }
    }
    // Each prism can slope along the run; concrete treads use equal heights at both ends.
    function prism(target:typeof steps | typeof rails, x0:number,x1:number,z0:number,z1:number,
      low0:number,high0:number,low1=low0,high1=high0,walkable=false) {
      if (collision) {
        const outline=[[x0,z0],[x1,z0],[x1,z1],[x0,z1]].map(([u,d])=>{
          const x=start[0]+tx*u-tz*d,z=start[1]+tz*u+tx*d;
          return [ox+x*cos+z*sin,oz-x*sin+z*cos];
        });
        const shape=rectangleBox(walkable?'stair-tread':'stairs',outline,Math.min(low0,low1),Math.max(high0,high1));
        if (low0===low1 && high0===high1) collision.push(shape);
        else collision.push({...shape,slope:{
          x:outline[0][0],z:outline[0][1],dx:outline[3][0]-outline[0][0],dz:outline[3][1]-outline[0][1],
          low0,low1,high0,high1,
        }});
        return;
      }
      const a:Vertex=[x0,low0,z0], b:Vertex=[x1,low0,z0], c:Vertex=[x1,low1,z1], d:Vertex=[x0,low1,z1];
      const e:Vertex=[x0,high0,z0], f:Vertex=[x1,high0,z0], g:Vertex=[x1,high1,z1], h:Vertex=[x0,high1,z1];
      face(target,[a,b,f,e]); face(target,[b,c,g,f]); face(target,[c,d,h,g]); face(target,[d,a,e,h]);
      face(target,[e,f,g,h]); face(target,[d,c,b,a]);
    }
    const middle=(low+high)/2, rise=(high-low)/2;
    const count=Math.ceil(rise/.20), stepHeight=rise/count;
    const landing=Math.min(.9,Math.max(.62,length*.34)), run=length-landing, tread=run/count;
    const wallDepth=.10;
    const gap=.06, left=width/2-gap/2, right=width/2+gap/2;
    prism(steps,0,wallDepth,0,length,low,high);
    prism(steps,width-wallDepth,width,0,length,low,high);
    const treadBox=(x0:number,x1:number,z0:number,z1:number,y:number,depth:number)=>
      prism(steps,x0,x1,z0,z1,y-depth,y,y-depth,y,true);
    for (let i=0;i<count;i++) {
      const y=low+(i+1)*stepHeight, z=i*tread;
      treadBox(wallDepth,left,z,z+tread,y,.14);
      const upper=high-i*stepHeight;
      treadBox(right,width-wallDepth,z,z+tread,upper,.14);
    }
    const supportHalf=Math.min(.11,(left-wallDepth)/4);
    const leftCenter=(left+wallDepth)/2, rightCenter=(right+width-wallDepth)/2;
    prism(steps,leftCenter-supportHalf,leftCenter+supportHalf,0,run,low-.22,low-.04,middle-.22,middle-.04);
    prism(steps,rightCenter-supportHalf,rightCenter+supportHalf,0,run,high-.22,high-.04,middle-.22,middle-.04);
    treadBox(wallDepth,width-wallDepth,run,length,middle,.16);
    for (const [x,firstY,lastY] of [[left-.025,low,middle],[right+.025,high,middle]]) {
      for (const fraction of [.04,.5,.96]) {
        const z=run*fraction, y=firstY+(lastY-firstY)*fraction;
        prism(rails,x-.016,x+.016,z-.016,z+.016,y-.1,y+.87);
      }
      prism(rails,x-.026,x+.026,run*.04,run*.96,
        firstY+(lastY-firstY)*.04+.85,firstY+(lastY-firstY)*.04+.90,
        firstY+(lastY-firstY)*.96+.85,firstY+(lastY-firstY)*.96+.90);
    }
    const railEnd=length-.045;
    for (const x of [wallDepth+.05,width-wallDepth-.05]) prism(rails,x-.016,x+.016,railEnd-.016,railEnd+.016,middle-.05,middle+.87);
    prism(rails,wallDepth+.034,width-wallDepth-.034,railEnd-.024,railEnd+.024,middle+.85,middle+.90);
  }
  return {steps,rails};
}

export const ENTRANCE_FLOOR_OFFSET = .01;
export const SLAB_DEPTH=.25;
export const SHAFT_WALL_DEPTH=.12;

export function interiorLayout({profile,facade}:Pick<BuildingInteriorSource,'profile'|'facade'>) {
  const ground=profile.entrance.base+ENTRANCE_FLOOR_OFFSET;
  const top=profile.height-.5;
  let previous=ground;
  const upperFloors:{height:number;depth:number}[]=[];
  for(let row=1;row<profile.floorCount;row++){
    const height=profile.facadeBase+row*profile.floorHeight;
    const depth=Math.min(SLAB_DEPTH,height-previous-2);
    if(depth<=0||top-height<2)continue;
    upperFloors.push({height,depth});
    previous=height;
  }
  const footprint:number[]=[], localFootprint:Point[]=[];
  const [ox,,oz]=profile.origin, cos=Math.cos(profile.yaw), sin=Math.sin(profile.yaw);
  for(let i=0;i<facade.indices.length;i+=3){
    const a=facade.indices[i], b=facade.indices[i+1], c=facade.indices[i+2];
    if(facade.uvs?.[a*2]!==-2||facade.uvs[b*2]!==-2||facade.uvs[c*2]!==-2)continue;
    for(const index of [a,b,c]){
      const x=facade.positions[index*3]-ox,z=facade.positions[index*3+2]-oz;
      localFootprint[index]=[x*cos-z*sin,x*sin+z*cos];
      footprint.push(index);
    }
  }
  const openings=upperFloors.length?floorOpenings(profile,localFootprint,footprint):[];
  return {ground,top,upperFloors,footprint,localFootprint,openings};
}

type Slab = {readonly minY:number;readonly maxY:number};
type InteriorContact = {readonly slabs:readonly Slab[];readonly boxes:readonly CollisionBox[];readonly onStairs:boolean};
type Position = {x:number;y:number;z:number};
export type DoorPose = {readonly id:string;readonly left:number;readonly right:number};

function rectangleBox(id:string,outline:number[][],minY:number,maxY:number):CollisionBox {
  return {id,outline,minY,maxY,minX:Math.min(...outline.map(p=>p[0])),maxX:Math.max(...outline.map(p=>p[0])),
    minZ:Math.min(...outline.map(p=>p[1])),maxZ:Math.max(...outline.map(p=>p[1]))};
}

const EMPTY_INTERIOR = Object.freeze({
  slabs:Object.freeze([] as Slab[]),boxes:Object.freeze([] as CollisionBox[]),onStairs:false,
});

function remember<K,V>(cache:Map<K,V>,key:K,limit:number,create:()=>V):V {
  const found=cache.get(key);
  if(found!==undefined){
    cache.delete(key);
    cache.set(key,found);
    return found;
  }
  const value=create();
  cache.set(key,value);
  if(cache.size>limit){
    const oldest=cache.keys().next();
    if(!oldest.done)cache.delete(oldest.value);
  }
  return value;
}

export function createInteriorCollision(sources:readonly BuildingInteriorSource[]) {
  const cells=new Map<string,BuildingInteriorSource[]>();
  const cell=32;
  for (const source of sources) {
    const b=source.bounds;
    for(let x=Math.floor((b.minX-.5)/cell);x<=Math.floor((b.maxX+.5)/cell);x++)
      for(let z=Math.floor((b.minZ-.5)/cell);z<=Math.floor((b.maxZ+.5)/cell);z++) {
        const key=`${x}/${z}`, list=cells.get(key);
        if(list)list.push(source);else cells.set(key,[source]);
      }
  }
  const plans=new Map<BuildingInteriorSource,ReturnType<typeof prepare>>();
  function prepare(source:BuildingInteriorSource) {
    const {profile}=source;
    const [ox,oy,oz]=profile.origin,cos=Math.cos(profile.yaw),sin=Math.sin(profile.yaw);
    const {ground,top,upperFloors,footprint,localFootprint,openings}=interiorLayout(source);
    const levels=[oy+ground,...upperFloors.map(f=>oy+f.height)];
    const slabs:Slab[]=[{minY:levels[0]-SLAB_DEPTH,maxY:levels[0]},
      ...upperFloors.map(f=>({minY:oy+f.height-f.depth,maxY:oy+f.height}))];
    const roof={minY:oy+top,maxY:oy+top+SLAB_DEPTH};
    const triangles:(Rectangle & {a:Point;b:Point;c:Point})[]=[];
    for(let i=0;i<footprint.length;i+=3){
      const a=localFootprint[footprint[i]],b=localFootprint[footprint[i+1]],c=localFootprint[footprint[i+2]];
      const minX=Math.min(a[0],b[0],c[0]),maxX=Math.max(a[0],b[0],c[0]);
      const minZ=Math.min(a[1],b[1],c[1]),maxZ=Math.max(a[1],b[1],c[1]);
      triangles.push({a,b,c,minX,maxX,minZ,maxZ});
    }
    const shafts=openings.filter(o=>o.kind==='elevator').map(opening=>({
      opening,
      walls:undefined as CollisionBox[]|undefined,
      doors:new Map<number,CollisionBox[]>(),
    }));
    const stairs=openings.filter(o=>o.kind==='staircase').map(opening=>({
      opening,levels:new Map<number,StairCollision[]>(),
    }));
    function shaftParts(opening:Opening,level?:number) {
      const result:CollisionBox[]=[];
      const corners=openingCorners(opening);
      for(let side=0;side<4;side++){
        if((side===opening.front)!==(level!==undefined))continue;
        const a=corners[side], b=corners[(side+1)%4];
        const span=Math.hypot(b[0]-a[0],b[1]-a[1]);
        const tx=(b[0]-a[0])/span,tz=(b[1]-a[1])/span;
        function wall(start:number,end:number,low:number,high:number,id='shaft'){
          if(high<=low)return;
          const x=a[0]+start*tx,z=a[1]+start*tz,ex=a[0]+end*tx,ez=a[1]+end*tz;
          const nx=-tz*SHAFT_WALL_DEPTH,nz=tx*SHAFT_WALL_DEPTH;
          const outline=[[x,z],[ex,ez],[ex+nx,ez+nz],[x+nx,z+nz]].map(([u,v])=>[ox+u*cos+v*sin,oz-u*sin+v*cos]);
          result.push(rectangleBox(`${source.id}/${id}`,outline,low,high));
        }
        if(level===undefined){wall(0,span,levels[0],roof.minY);continue;}
        const half=Math.min(.55,span/2-.15),left=span/2-half,right=span/2+half;
        const low=levels[level],high=levels[level+1]??roof.minY;
        const lintel=Math.min(low+2.1,high-(upperFloors[level]?.depth??0)-.03);
        wall(0,left,low,high);
        wall(right,span,low,high);
        wall(left,right,lintel,high);
        wall(left,right,low,lintel,'elevator-door');
      }
      return result;
    }
    function contains(x:number,z:number){
      const side=(p:Point,q:Point)=>(q[0]-p[0])*(z-p[1])-(q[1]-p[1])*(x-p[0]);
      for(const t of triangles){
        // The margin is wider than the edge test's tolerance for prepared facade triangles.
        if(x<t.minX-.001||x>t.maxX+.001||z<t.minZ-.001||z>t.maxZ+.001)continue;
        const {a,b,c}=t;
        if(side(a,b)>=-1e-7&&side(b,c)>=-1e-7&&side(c,a)>=-1e-7)return true;
      }
      return false;
    }
    function levelAt(y:number) {
      let low=0,high=levels.length-1;
      while(low<high){
        const middle=Math.floor((low+high+1)/2);
        if(y>=levels[middle])low=middle;else high=middle-1;
      }
      return low;
    }
    function horizontal(x:number,z:number) {
      const u=(x-ox)*cos-(z-oz)*sin, v=(x-ox)*sin+(z-oz)*cos;
      const inside=(o:Rectangle,pad=0)=>u>=o.minX-pad&&u<=o.maxX+pad&&v>=o.minZ-pad&&v<=o.maxZ+pad;
      return {
        contains:contains(u,v),cutout:openings.some(o=>inside(o)),
        shafts:shafts.filter(({opening})=>inside(opening,.6)),
        stairs:stairs.filter(({opening})=>inside(opening,.45)),
      };
    }
    let last: {x:number;z:number;result:ReturnType<typeof horizontal>} | undefined;
    return {slabs,levels,shaftParts,levelAt,roof,queryXZ(x:number,z:number){
      if(last?.x===x&&last.z===z)return last.result;
      const result=horizontal(x,z);
      last={x,z,result};
      return result;
    }};
  }
  function sample(x:number,z:number,minY:number,maxY:number):InteriorContact {
    const candidates=cells.get(`${Math.floor(x/cell)}/${Math.floor(z/cell)}`);
    if(!candidates)return EMPTY_INTERIOR;
    const slabs:Slab[]=[],boxes:CollisionBox[]=[];
    let onStairs=false;
    for(const source of candidates){
      const b=source.bounds,p=source.profile;
      if(x<b.minX-.5||x>b.maxX+.5||z<b.minZ-.5||z>b.maxZ+.5||maxY<p.origin[1]-1||minY>p.origin[1]+p.height)continue;
      // shortcut: keep a small working set for the local actors; reconsider with a large server population.
      const data=remember(plans,source,12,()=>prepare(source));
      const horizontal=data.queryXZ(x,z);
      const first=data.levelAt(minY-1.1),last=data.levelAt(maxY+.25);
      const inHeight=(slab:Slab)=>slab.maxY>=minY-.3&&slab.minY<=maxY+.3;
      if(horizontal.contains){
        if(inHeight(data.slabs[0]))slabs.push(data.slabs[0]);
        if(inHeight(data.roof))slabs.push(data.roof);
        if(!horizontal.cutout)for(let i=Math.max(1,first);i<=last+1 && i<data.slabs.length;i++){
          if(inHeight(data.slabs[i]))slabs.push(data.slabs[i]);
        }
      }
      const close=(b:CollisionBox)=>x>b.minX-.4&&x<b.maxX+.4&&z>b.minZ-.4&&z<b.maxZ+.4&&b.maxY>=minY&&b.minY<=maxY;
      for(const shaft of horizontal.shafts){
        shaft.walls??=data.shaftParts(shaft.opening);
        for(const wall of shaft.walls)if(close(wall))boxes.push(wall);
        for(let i=first;i<=last;i++){
          if(data.levels[i]>maxY||(data.levels[i+1]??data.roof.minY)<minY)continue;
          const parts=remember(shaft.doors,i,8,()=>data.shaftParts(shaft.opening,i));
          for(const wall of parts)if(close(wall))boxes.push(wall);
        }
      }
      for(const stair of horizontal.stairs){
        onStairs=true;
        for(let i=first;i<=last&&i+1<data.levels.length;i++){
          const low=data.levels[i],high=data.levels[i+1];
          if(high+1<minY||low-.25>maxY)continue;
          const parts=remember(stair.levels,i,8,()=>{
            const result:StairCollision[]=[];
            buildStairs(p,[stair.opening],low,high,result);
            return result;
          });
          for(const part of parts)if(close(part)){
            const span=part.slope;
            if(!span){boxes.push(part);continue;}
            const t=Math.max(0,Math.min(1,((x-span.x)*span.dx+(z-span.z)*span.dz)/(span.dx*span.dx+span.dz*span.dz)));
            boxes.push({...part,minY:span.low0+(span.low1-span.low0)*t,maxY:span.high0+(span.high1-span.high0)*t});
          }
        }
      }
    }
    return slabs.length||boxes.length||onStairs ? {slabs,boxes,onStairs} : EMPTY_INTERIOR;
  }
  let last: {x:number;z:number;minY:number;maxY:number;result:ReturnType<typeof sample>} | undefined;
  return {at(x:number,z:number,minY:number,maxY:number){
    if(last?.x===x&&last.z===z&&last.minY===minY&&last.maxY===maxY)return last.result;
    const result=sample(x,z,minY,maxY);
    last={x,z,minY,maxY,result};
    return result;
  }};
}

export type DoorPart = readonly [left:number,right:number,bottom:number,top:number,front:number,back:number];
export const ENTRANCE_SWING = 5*Math.PI/12;

export function doorLeafParts(door:BuildingDoor,sign:number):readonly DoorPart[] {
  const meeting=-sign*door.width/2, gap=.004;
  const left=Math.min(0,meeting+sign*gap),right=Math.max(0,meeting+sign*gap);
  const handle=meeting+sign*.25;
  return [
    [left,right,0,door.height,-.004,.076],
    [Math.max(left,meeting-.0625),Math.min(right,meeting+.0625),0,door.height,-.03,.10],
    [handle-.03125,handle+.03125,1,1.5,-.0625,.135],
  ];
}

export function doorFrameParts(door:BuildingDoor,jambBottom=0):readonly DoorPart[] {
  const half=door.width/2,trim=.25,top=door.height;
  return [[-half-trim,-half,jambBottom,top+trim,-.09375,.86],
    [half,half+trim,jambBottom,top+trim,-.09375,.86],
    [-half,half,top,top+trim,-.09375,.86]];
}

function doorBoxes(door:BuildingDoor, parts:readonly DoorPart[], hinge:number,angle:number) {
  const cos=Math.cos(angle),sin=Math.sin(angle);
  const x=door.x+hinge*door.tx,z=door.z+hinge*door.tz;
  return parts.map(([a,b,low,high,c,d])=>{
    const outline=[[a,c],[b,c],[b,d],[a,d]].map(([u,v])=>{
      const dx=u*door.tx+v*door.tz,dz=u*door.tz-v*door.tx;
      return [x+dx*cos+dz*sin,z-dx*sin+dz*cos];
    });
    return rectangleBox(`${door.id}/door`,outline,door.y+low,door.y+high);
  });
}

function leafBoxes(door:BuildingDoor,sign:number,open:number) {
  return doorBoxes(door,doorLeafParts(door,sign),sign*door.width/2,-sign*ENTRANCE_SWING*open);
}

function boxesOverlap(a:CollisionBox,b:CollisionBox) {
  if(a.maxY<=b.minY+1e-6||b.maxY<=a.minY+1e-6||a.maxX<=b.minX||b.maxX<=a.minX||a.maxZ<=b.minZ||b.maxZ<=a.minZ)return false;
  const polygon=(box:CollisionBox)=>box.outline??[[box.minX,box.minZ],[box.maxX,box.minZ],[box.maxX,box.maxZ],[box.minX,box.maxZ]];
  const first=polygon(a),second=polygon(b);
  for(const outline of [first,second]) for(let i=0;i<outline.length;i++){
    const p=outline[i],q=outline[(i+1)%outline.length],nx=q[1]-p[1],nz=p[0]-q[0];
    const x=first.map(v=>v[0]*nx+v[1]*nz),z=second.map(v=>v[0]*nx+v[1]*nz);
    if(Math.max(...x)<=Math.min(...z)+1e-7||Math.max(...z)<=Math.min(...x)+1e-7)return false;
  }
  return true;
}

export function createEntranceMotion(doors:readonly BuildingDoor[]) {
  const cells=new Map<string,BuildingDoor[]>();
  const cell=8;
  for(const door of doors)for(let x=Math.floor((door.x-4)/cell);x<=Math.floor((door.x+4)/cell);x++)
    for(let z=Math.floor((door.z-4)/cell);z<=Math.floor((door.z+4)/cell);z++){
      const key=`${x}/${z}`,list=cells.get(key);
      if(list)list.push(door);else cells.set(key,[door]);
    }
  const near=(x:number,z:number)=>cells.get(`${Math.floor(x/cell)}/${Math.floor(z/cell)}`)??[];
  const states=new Map<BuildingDoor,{left:number;right:number;opening:boolean;boxes:CollisionBox[]}>();
  const closed=new WeakMap<BuildingDoor,CollisionBox[]>();
  const frames=new WeakMap<BuildingDoor,CollisionBox[]>();
  let snapshot:readonly DoorPose[]=Object.freeze([]);
  return {
    at(x:number,z:number,y:number) {
      const boxes:CollisionBox[]=[];
      for(const door of near(x,z)){
        if(Math.abs(x-door.x)>2.7||Math.abs(z-door.z)>2.7||y<door.y-4||y>door.y+door.height+4)continue;
        let frame=frames.get(door);
        if(!frame){frame=doorBoxes(door,doorFrameParts(door),0,0);frames.set(door,frame);}
        boxes.push(...frame);
        const moving=states.get(door);
        if(moving){boxes.push(...moving.boxes);continue;}
        let blockers=closed.get(door);
        if(!blockers){blockers=[...leafBoxes(door,-1,0),...leafBoxes(door,1,0)];closed.set(door,blockers);}
        boxes.push(...blockers);
      }
      return boxes;
    },
    step(actor:Position,radius:number,height:number,blockers:(door:BuildingDoor)=>readonly CollisionBox[]) {
      const candidates=new Set([...states.keys(),...near(actor.x,actor.z)]);
      const body=rectangleBox('actor',[[actor.x-radius,actor.z-radius],[actor.x+radius,actor.z-radius],
        [actor.x+radius,actor.z+radius],[actor.x-radius,actor.z+radius]],actor.y,actor.y+height);
      let changed=false;
      for(const door of candidates){
        const state=states.get(door)??{left:0,right:0,opening:false,boxes:[]};
        const distance=Math.hypot(actor.x-door.x,actor.z-door.z,Math.max(door.y-actor.y,0,actor.y-door.y-door.height));
        state.opening=distance<=(state.opening?3:2.5);
        if(!state.opening&&!state.left&&!state.right){states.delete(door);continue;}
        if(state.opening&&state.left===1&&state.right===1)continue;
        let adjusted=false;
        const staticBoxes=blockers(door);
        for(const [key,sign] of [['left',-1],['right',1]] as const){
          const from=state[key],to=state.opening?Math.min(1,from+1/24):Math.max(0,from-1/24);
          if(to===from)continue;
          const blocked=[(from+to)/2,to].some(angle=>leafBoxes(door,sign,angle).some(leaf=>
            boxesOverlap(leaf,body)||staticBoxes.some(box=>boxesOverlap(leaf,box))));
          if(!blocked){state[key]=to;adjusted=true;}
        }
        changed ||= adjusted;
        if(!state.opening&&!state.left&&!state.right){states.delete(door);continue;}
        if(adjusted||!state.boxes.length)state.boxes=[...leafBoxes(door,-1,state.left),...leafBoxes(door,1,state.right)];
        states.set(door,state);
      }
      if(changed)snapshot=Object.freeze([...states].filter(([,s])=>s.left||s.right).map(([door,s])=>
        Object.freeze({id:door.id,left:s.left,right:s.right})));
    },
    snapshot:()=>snapshot,
  };
}
