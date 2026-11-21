import { STEP_MS } from '../../simulation/authority.ts';
import { LOCOMOTION_SPEEDS } from '../characters/headless.ts';
import { interiorLayout, stairWalkPath } from '../building-interiors/headless.ts';
import type { BuildingInteriorSource, CollisionBox, CollisionWorld } from '../world/headless.ts';
import type { CityMesh, CitySource } from '../world-generation/headless.ts';

type Point = readonly [x: number, y: number, z: number];
type Mode = 'walk' | 'run' | 'drive' | 'idle';
type Node = { id: string; point: Point; cost: number; links: Node[] };
type Visit = { id: string; node: Node; paths: readonly (readonly Point[])[] };
type Profile = { travel: 'walk' | 'drive'; north: number; running: number; indoors: number; shortcuts: number };
const profiles: readonly Profile[] = [
  { travel: 'walk', north: .8, running: .14, indoors: .22, shortcuts: .08 },
  { travel: 'walk', north: -.7, running: .65, indoors: .08, shortcuts: .4 },
  { travel: 'walk', north: 0, running: .05, indoors: .78, shortcuts: .02 },
  { travel: 'drive', north: .55, running: 0, indoors: 0, shortcuts: .03 },
  { travel: 'drive', north: -.65, running: 0, indoors: 0, shortcuts: .08 },
];
const CELL = 32;
const GRID = 2;
export const NPC_RADIUS = 76;
export const TRAFFIC_RADIUS = 155;
const LEAD_TICKS = 180;
const TERRAIN_CELL = 8;
const WALK_COVERAGE_CELL = 36;
const SURFACES = new Map([['sidewalk', 1], ['park-path', 1], ['terrain', 1.45], ['urban-ground', 1.7], ['curb', 1.25], ['road', 3.2]]);
export function isNpcSurface(surface: string) { return SURFACES.has(surface); }

type Triangle = { a: Point; b: Point; c: Point; cost: number };
const cellKey = (x: number, z: number) => `${x}/${z}`;
function distance(a: Point,b: Point) {
  const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2];
  return Math.sqrt(dx*dx+dy*dy+dz*dz);
}
const mix = (a: Point, b: Point, t: number): Point =>
  [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];

function cells(minX: number, maxX: number, minZ: number, maxZ: number, use: (key: string) => void, size=CELL) {
  for (let x=Math.floor(minX/size); x<=Math.floor(maxX/size); x++)
    for (let z=Math.floor(minZ/size); z<=Math.floor(maxZ/size); z++) use(cellKey(x,z));
}

function add<K,V>(map: Map<K,V[]>, key: K, entry: V) {
  const list=map.get(key);
  if (list) list.push(entry);
  else map.set(key,[entry]);
}

function hash(text: string, initial = 2166136261) {
  let value=initial;
  for (let i=0; i<text.length; i++) value=Math.imul(value^text.charCodeAt(i),16777619);
  return value>>>0;
}

function random(seed: number) {
  let state=seed;
  return () => {
    state=(state+0x6d2b79f5)|0;
    let v=Math.imul(state^(state>>>15),state|1);
    v^=v+Math.imul(v^(v>>>7),v|61);
    return ((v^(v>>>14))>>>0)/4294967296;
  };
}

function heightAt(a: Point, b: Point, c: Point, x: number, z: number) {
  const denominator=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);
  if (Math.abs(denominator)<1e-8) return;
  const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/denominator;
  const v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/denominator;
  if (u>=-1e-6 && v>=-1e-6 && u+v<=1+1e-6) return u*a[1]+v*b[1]+(1-u-v)*c[1];
}

function blocked(box: CollisionBox, x: number, z: number, clearance: number) {
  if (x<box.minX-clearance || x>box.maxX+clearance || z<box.minZ-clearance || z>box.maxZ+clearance) return false;
  const polygon=box.outline;
  if (!polygon?.length) return true;
  let inside=false;
  for (let i=0,j=polygon.length-1; i<polygon.length; j=i++) {
    const [ax,az]=polygon[j], [bx,bz]=polygon[i];
    if ((az>z)!==(bz>z) && x<(bx-ax)*(z-az)/(bz-az)+ax) inside=!inside;
    const dx=bx-ax,dz=bz-az;
    const t=Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/(dx*dx+dz*dz || 1)));
    if (Math.hypot(x-ax-dx*t,z-az-dz*t)<clearance) return true;
  }
  return inside;
}

function samples(a: Point, b: Point, check: (p: Point) => boolean) {
  const count=Math.max(1,Math.ceil(distance(a,b)/.45));
  for (let i=0; i<=count; i++) if (!check(mix(a,b,i/count))) return false;
  return true;
}

function search(start: Node, goal: Node, links: (node: Node) => readonly Node[], cost: (a: Node, b: Node) => number, heuristicWeight: number, budget: number) {
  type Entry = { node: Node; g: number; score: number };
  const queue: Entry[]=[];
  function push(entry: Entry) {
    let i=queue.length;
    queue.push(entry);
    while (i>0) {
      const parent=(i-1)>>1;
      if (queue[parent].score<=entry.score) break;
      queue[i]=queue[parent];
      i=parent;
    }
    queue[i]=entry;
  }
  function pop() {
    const first=queue[0], last=queue.pop()!;
    if (!queue.length) return first;
    let i=0;
    while (i*2+1<queue.length) {
      let child=i*2+1;
      if (child+1<queue.length && queue[child+1].score<queue[child].score) child++;
      if (queue[child].score>=last.score) break;
      queue[i]=queue[child];
      i=child;
    }
    queue[i]=last;
    return first;
  }
  const best=new Map([[start,0]]);
  const previous=new Map<Node,Node>();
  push({node:start,g:0,score:0});
  for (let iterations=0; queue.length && iterations<budget; iterations++) {
    const {node,g}=pop();
    if (g!==best.get(node)) continue;
    if (node===goal) {
      const path=[node];
      for (let p=previous.get(node); p; p=previous.get(p)) path.push(p);
      return path.reverse();
    }
    for (const next of links(node)) {
      const total=g+distance(node.point,next.point)*cost(node,next);
      if (total>=(best.get(next)??Infinity)) continue;
      best.set(next,total);
      previous.set(next,node);
      push({node:next,g:total,score:total+heuristicWeight*distance(next.point,goal.point)});
    }
  }
}

type NavigationSource = Pick<CitySource,'id'|'version'|'bounds'|'roads'|'trafficLayout'> &
  {readonly chunks:readonly {readonly meshes:readonly CityMesh[]}[]};

export function createNpcNavigation(city: NavigationSource, world: Pick<CollisionWorld,'spawn'|'blockers'|'doors'>, interiors: readonly BuildingInteriorSource[]) {
  const {bounds}=city;
  const within=(x: number,z: number) => x>=bounds.minX&&x<=bounds.maxX&&z>=bounds.minZ&&z<=bounds.maxZ;
  const triangles=new Map<string,Triangle[]>(), boxes=new Map<string,CollisionBox[]>();
  const walkSites=new Map<string,{key:string;x:number;z:number;area:number;points:Point[]}>();
  const siteRandom=random(hash(city.id));
  let revision=hash(`npc/14/${city.id}/${city.version}/${world.spawn.x}/${world.spawn.z}`);
  for (const chunk of city.chunks) {
    for (const mesh of chunk.meshes) {
      const cost=SURFACES.get(mesh.surface);
      if (cost===undefined) continue;
      revision=hash(JSON.stringify(mesh),revision);
      const point=(i: number): Point => [mesh.positions[3*i],mesh.positions[3*i+1],mesh.positions[3*i+2]];
      for (let i=0; i<mesh.indices.length; i+=3) {
        const a=point(mesh.indices[i]), b=point(mesh.indices[i+1]), c=point(mesh.indices[i+2]);
        const t={a,b,c,cost};
        if (cost<=1.7) {
          const x=(a[0]+b[0]+c[0])/3,z=(a[2]+b[2]+c[2])/3;
          const ix=Math.floor(x/WALK_COVERAGE_CELL),iz=Math.floor(z/WALK_COVERAGE_CELL);
          const key=cellKey(ix,iz);
          const area=Math.abs((b[0]-a[0])*(c[2]-a[2])-(c[0]-a[0])*(b[2]-a[2]))/2;
          if (area>.05) {
            let site=walkSites.get(key);
            if (!site) {
              site={key,x:ix,z:iz,area:0,points:[]};
              walkSites.set(key,site);
            }
            const weight=area*(cost===1?1.6:1);
            site.area+=weight;
            const point:Point=[x,(a[1]+b[1]+c[1])/3,z];
            if (site.points.length<8) site.points.push(point);
            else if (siteRandom()<8*weight/site.area) site.points[Math.floor(siteRandom()*8)]=point;
          }
        }
        cells(Math.min(a[0],b[0],c[0]),Math.max(a[0],b[0],c[0]),Math.min(a[2],b[2],c[2]),Math.max(a[2],b[2],c[2]),
          key=>add(triangles,key,t),TERRAIN_CELL);
      }
    }
  }
  for (const box of world.blockers) {
    revision=hash(JSON.stringify(box),revision);
    cells(box.minX-2,box.maxX+2,box.minZ-2,box.maxZ+2,key=>add(boxes,key,box),TERRAIN_CELL);
  }
  const tile=(x: number,z: number)=>cellKey(Math.floor(x/TERRAIN_CELL),Math.floor(z/TERRAIN_CELL));
  function ground(x: number,z: number,road=false) {
    let best: { point: Point; cost: number } | undefined;
    for (const {a,b,c,cost} of triangles.get(tile(x,z))??[]) {
      if (road && cost!==3.2) continue;
      const y=heightAt(a,b,c,x,z);
      if (y!==undefined && (!best || y>best.point[1]+.005 || (Math.abs(y-best.point[1])<=.005 && cost<best.cost)))
        best={point:[x,y,z],cost};
    }
    return best;
  }
  const clear=(x: number,z: number,clearance=.33,ignore?: string)=>
    !(boxes.get(tile(x,z))??[]).some(box=>box.id!==ignore && blocked(box,x,z,clearance));
  const crossings=new Map<string,{shape:CollisionBox; direction:readonly number[]}[]>();
  for (const crossing of city.trafficLayout?.crosswalks??[]) {
    const xs=crossing.outline.map(p=>p[0]),zs=crossing.outline.map(p=>p[1]);
    const shape={id:'crosswalk',outline:crossing.outline,minX:Math.min(...xs),maxX:Math.max(...xs),
      minZ:Math.min(...zs),maxZ:Math.max(...zs),minY:0,maxY:0};
    revision=hash(JSON.stringify(crossing.outline),revision);
    cells(shape.minX,shape.maxX,shape.minZ,shape.maxZ,key=>add(crossings,key,{shape,direction:crossing.direction}),TERRAIN_CELL);
  }
  function marked(x: number,z: number,dx=0,dz=0) {
    return (crossings.get(tile(x,z))??[]).some(({shape,direction})=>
      Math.abs(dx*direction[0]+dz*direction[1])<=1.8 && blocked(shape,x,z,0));
  }
  const crossingCosts=new WeakMap<Node,Map<Node,number>>();
  const walking=new Map<string,Node|null>();
  const connected=new Set<Node>();
  function foot(x: number,z: number) {
    const ix=Math.round(x/GRID), iz=Math.round(z/GRID), id=`p/${ix}/${iz}`;
    if (walking.has(id)) return walking.get(id)??undefined;
    x=ix*GRID; z=iz*GRID;
    const sample=within(x,z)&&clear(x,z)?ground(x,z):undefined;
    const node=sample?{id,...sample,links:[]}:null;
    walking.set(id,node);
    return node??undefined;
  }
  function footLinks(node: Node) {
    if (!connected.has(node)) {
      connected.add(node);
      for (const dx of [-GRID,0,GRID]) for (const dz of [-GRID,0,GRID]) {
        if (!dx && !dz) continue;
        const next=foot(node.point[0]+dx,node.point[2]+dz);
        if (!next || Math.abs(next.point[1]-node.point[1])>=.65) continue;
        let penalty=0;
        if (!samples(node.point,next.point,p=>{
          const surface=ground(p[0],p[2]);
          if (!surface || Math.abs(surface.point[1]-p[1])>=.38 || !clear(p[0],p[2])) return false;
          if (surface.cost===3.2) penalty=Math.max(penalty,marked(p[0],p[2],dx,dz)?1:4.5);
          return true;
        })) continue;
        node.links.push(next);
        if (penalty) {
          let costs=crossingCosts.get(node);
          if (!costs) crossingCosts.set(node,costs=new Map());
          costs.set(next,penalty);
        }
      }
    }
    return node.links;
  }
  const driving=new Map<string,Node>();
  for (const road of city.roads) {
    if (!road.points.some(([x,z])=>within(x,z))) continue;
    revision=hash(JSON.stringify(road),revision);
    let previous: Node|undefined;
    for (const [x,z] of road.points) {
      const p=within(x,z)?ground(x,z,true):undefined;
      const id=`r/${road.layer}/${x}/${z}`;
      let node=driving.get(id);
      if (p && !node) {
        node={id,...p,links:[]};
        driving.set(id,node);
      }
      if (previous && node && previous!==node && samples(previous.point,node.point,p=>!!ground(p[0],p[2],true))) {
        if (road.oneway!=='-1') previous.links.push(node);
        if (road.oneway!=='yes') node.links.push(previous);
      }
      previous=node;
    }
  }
  const roadNodes=[...driving.values()].filter(node=>node.links.length);
  const roadCells=new Map<string,Node[]>();
  for (const node of roadNodes) cells(node.point[0],node.point[0],node.point[2],node.point[2],key=>add(roadCells,key,node),128);
  function roadsNear(x: number,z: number,radius: number) {
    const near: Node[]=[];
    cells(x-radius,x+radius,z-radius,z+radius,key=>{
      for (const road of roadCells.get(key)??[]) near.push(road);
    },128);
    return near;
  }
  const parkingCache=new Map<Node,{point:Point;approach:Point;yaw:number}|undefined>();
  function parking(node: Node) {
    if (parkingCache.has(node)) return parkingCache.get(node);
    let spot: {point:Point;approach:Point;yaw:number}|undefined;
    const [x,y,z]=node.point;
    for (const next of node.links) {
      const length=distance(node.point,next.point);
      if (length<12) continue;
      const dx=(next.point[0]-x)/length,dz=(next.point[2]-z)/length;
      const along=Math.min(12,length*.48);
      const px=x+dx*along,pz=z+dz*along;
      let edge=2;
      while (edge<14&&ground(px+dz*edge,pz-dx*edge,true)) edge+=.5;
      const shift=edge-2.2;
      if (shift<4.3) continue;
      const sample=ground(px+dz*shift,pz-dx*shift,true)?.point;
      if (!sample || Math.abs(sample[1]-y)>.85) continue;
      if (![-2.5,0,2.5].every(t=>[-1.05,0,1.05].every(s=>{
        const sx=sample[0]+dx*t+dz*s,sz=sample[2]+dz*t-dx*s;
        return !!ground(sx,sz,true)&&clear(sx,sz,.25)&&!marked(sx,sz);
      }))) continue;
      const approach=ground(sample[0]-dx*3,sample[2]-dz*3,true)?.point;
      const ready=(p: Point)=>!!ground(p[0],p[2],true)&&clear(p[0],p[2],.8)&&!marked(p[0],p[2]);
      if (!approach || !samples(node.point,approach,ready) || !samples(approach,sample,ready)) continue;
      spot={point:sample,approach,yaw:Math.atan2(dx,dz)};
      break;
    }
    parkingCache.set(node,spot);
    return spot;
  }
  const offRoad=new Map<Node,Node[]>();
  // A shortcut must fit the vehicle on dry paved ground, away from buildings and props.
  for (const a of roadNodes) for (const b of roadsNear(a.point[0],a.point[2],19)) {
    if (a.id>=b.id) continue;
    const length=distance(a.point,b.point);
    if (length<7 || length>19 || a.links.includes(b) || b.links.includes(a) ||
        a.id.split('/')[1]!==b.id.split('/')[1]) continue;
    let crossesPavement=false;
    const nx=(b.point[2]-a.point[2])/length,nz=(a.point[0]-b.point[0])/length;
    const pass=samples(a.point,b.point,p=>{
      const center=ground(p[0],p[2]);
      if (center?.cost===1.7) crossesPavement=true;
      return [-1.15,0,1.15].every(offset=>{
        const x=p[0]+nx*offset,z=p[2]+nz*offset,surface=ground(x,z);
        return surface && surface.cost>=1.25 && surface.cost!==1.45 &&
          Math.abs(surface.point[1]-p[1])<.28 && clear(x,z,.22);
      });
    });
    if (pass && crossesPavement) {add(offRoad,a,b);add(offRoad,b,a);}
  }
  const visits: Visit[]=[];
  const doors=new Map(world.doors?.map(door=>[door.id,door]));
  for (const source of interiors) {
    const door=doors.get(source.id);
    if (!door || !within(door.x,door.z)) continue;
    const plan=interiorLayout(source);
    const stairs=plan.openings.find(o=>o.stairFront!==undefined);
    if (!stairs || !plan.upperFloors.length) continue;
    const {origin:[ox,oy,oz],yaw}=source.profile;
    const cos=Math.cos(yaw),sin=Math.sin(yaw);
    const local=(x: number,z: number): [number,number]=>[(x-ox)*cos-(z-oz)*sin,(x-ox)*sin+(z-oz)*cos];
    const floor=oy+plan.ground;
    function lobby(x: number,z: number) {
      const [u,v]=local(x,z);
      if (plan.openings.some(o=>u>o.minX-.16 && u<o.maxX+.16 && v>o.minZ-.16 && v<o.maxZ+.16)) return false;
      for (let i=0; i<plan.footprint.length; i+=3) {
        const [a,b,c]=plan.footprint.slice(i,i+3).map(index=>plan.localFootprint[index]);
        if (heightAt([a[0],0,a[1]],[b[0],0,b[1]],[c[0],0,c[1]],u,v)!==undefined) return true;
      }
      return false;
    }
    const entrance: Point=[door.x,floor,door.z];
    const inward=[-1,1].map(sign=>({x:sign*door.tz,z:-sign*door.tx}))
      .find(n=>lobby(door.x+n.x*.85,door.z+n.z*.85));
    if (!inward) continue;
    const inside: Point=[door.x+inward.x*.85,floor,door.z+inward.z*.85];
    const firstPath=stairWalkPath(source.profile,stairs,plan.ground,plan.upperFloors[0].height);
    const first=firstPath[0];
    if (!samples(inside,first,p=>lobby(p[0],p[2]))) continue;
    const candidates: Node[]=[];
    for (let d=2; d<=8; d+=2) for (let lateral=-4; lateral<=4; lateral+=2) {
      const node=foot(door.x-inward.x*d+door.tx*lateral,door.z-inward.z*d+door.tz*lateral);
      if (node && !candidates.includes(node) && footLinks(node).length) candidates.push(node);
    }
    candidates.sort((a,b)=>distance(a.point,entrance)-distance(b.point,entrance));
    const node=candidates.find(n=>samples(n.point,entrance,p=>(distance(p,entrance)<.75||!!ground(p[0],p[2]))&&
      clear(p[0],p[2],.3,source.id) && !lobby(p[0],p[2]) &&
      (distance(p,entrance)<.6 || clear(p[0],p[2],.18))));
    if (!node) continue;
    const prefix=[node.point,entrance,inside,...firstPath];
    const paths=[prefix];
    for (let level=1; level<Math.min(4,plan.upperFloors.length); level++) {
      const path=stairWalkPath(source.profile,stairs,plan.upperFloors[level-1].height,plan.upperFloors[level].height);
      if (!samples(paths[level-1].at(-1)!,path[0],p=>lobby(p[0],p[2]))) break;
      paths.push([...paths[level-1],...path]);
    }
    revision=hash(JSON.stringify([source.id,paths]),revision);
    visits.push({id:source.id,node,paths});
  }
  function findFoot(x: number,z: number) {
    for (const d of [0,2,4,8,12]) for (const [dx,dz] of [[0,0],[d,0],[-d,0],[0,d],[0,-d],[d,d],[-d,-d]]) {
      const node=foot(x+dx,z+dz);
      if (node && node.cost!==3.2 && footLinks(node).length) return node;
    }
  }
  function walkingTree(root: Node) {
    const parents=new Map<Node,Node|null>();
    const best=new Map([[root,0]]);
    const queue:{node:Node;parent:Node|null}[][]=[[{node:root,parent:null}]];
    for (let cost=0;cost<queue.length&&parents.size<360;cost++) for (const visit of queue[cost]??[]) {
      if (parents.has(visit.node)) continue;
      parents.set(visit.node,visit.parent);
      if (parents.size>=360) break;
      for (const next of footLinks(visit.node)) {
        if (parents.has(next)) continue;
        const weight=crossingCosts.get(visit.node)?.get(next)??next.cost;
        const total=cost+Math.ceil(weight*2);
        if (total>=(best.get(next)??Infinity)) continue;
        best.set(next,total);
        (queue[total]??=[]).push({node:next,parent:visit.node});
      }
    }
    return parents;
  }
  const mapVersion=`${city.id}/${revision.toString(16)}`;
  return {
    version:`${mapVersion}/15`, mapVersion, spawn: world.spawn, bounds, roadNodes, roadsNear, parking, visits, findFoot, walkingTree, walkSites:[...walkSites.values()],
    node(id: string) {
      if (id.startsWith('r/')) return driving.get(id);
      const [kind,x,z]=id.split('/');
      if (kind==='p' && id===`p/${Number(x)}/${Number(z)}` && Number.isSafeInteger(Number(x)) &&
          Number.isSafeInteger(Number(z)) && within(Number(x)*GRID,Number(z)*GRID))
        return foot(Number(x)*GRID,Number(z)*GRID);
    },
    route(a: Node,b: Node,profile: Profile,seed: number,budget=profile.travel==='drive'?1600:1800,avoid?:ReadonlySet<Node>) {
      const car=profile.travel==='drive';
      const variation=hash(`route/${seed}`);
      const allowShortcut=car&&random(variation)()<profile.shortcuts;
      return search(a,b,car?node=>allowShortcut?[...node.links,...(offRoad.get(node)??[])]:node.links:avoid?node=>footLinks(node).filter(next=>next===b||!avoid.has(next)):footLinks,(u,v)=>{
        const jitter=(hash(`${u.id}|${v.id}`,variation)%101)/100;
        const base=car?(u.links.includes(v)?1:1.12):(crossingCosts.get(u)?.get(v)??(u.cost+v.cost)/2);
        return 1+(base-1)*(1-profile.shortcuts)+jitter*(car?.55:1.05);
      },car?1:1.75,budget);
    },
    walkOffset(a: Point,x: number,z: number) {
      const target=ground(x,z);
      if (!target || Math.abs(target.point[1]-a[1])>.32 || !clear(x,z)) return;
      const origin=ground(a[0],a[2]);
      if (!origin || Math.abs(origin.point[1]-a[1])>.32 ||
          target.cost>origin.cost+.3 || (marked(a[0],a[2])&&!marked(x,z))) return;
      return target.point;
    },
    roadPoint(x: number,z: number) { return ground(x,z,true)?.point; },
  };
}

export type NpcNavigation = ReturnType<typeof createNpcNavigation>;
export type NpcSeed = {
  readonly id: string;
  readonly personality: number;
  readonly seed: number;
  readonly anchor: string;
  readonly home: string;
  readonly startTick: number;
  readonly navigation: string;
  readonly crowd?: true;
  readonly wait?: number;
};
type Leg = { a: Point; b: Point; mode: Mode; from: number; until: number; distance: number; length: number; yaw: number; pitch: number; into: number; out: number; backing?: true; wheelStart?: number; door?: string };
type Reservation = { id: string; from: number; until: number };
const containsAt = (r: Reservation,tick: number)=>r.from<=tick&&r.until>tick;

function curvedRoad(path: readonly Node[], nav: NpcNavigation) {
  if (path.length<2) return [path[0].point];
  function lane(a: Point,b: Point,t: number) {
    const p=mix(a,b,t), dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);
    return nav.roadPoint(p[0]+1.45*dz/length,p[2]-1.45*dx/length)??p;
  }
  const result=[path[0].point];
  for (let i=1; i<path.length; i++) {
    const a=path[i-1].point,b=path[i].point,c=path[i+1]?.point;
    const standard=path[i-1].links.includes(path[i]);
    const part=Math.min(.32,4/distance(a,b));
    for (let j=0; j<=Math.ceil(distance(a,b)/6); j++) {
      const t=part+(1-2*part)*j/Math.ceil(distance(a,b)/6);
      result.push(standard?lane(a,b,t):mix(a,b,t));
    }
    if (!c) break;
    const entry=result.at(-1)!, t0=Math.min(.32,4/distance(b,c));
    const exit=path[i].links.includes(path[i+1])?lane(b,c,t0):mix(b,c,t0);
    const turn: Point[]=[];
    for (let j=1;j<5;j++) {
      const t=j/5, p=mix(mix(entry,b,t),mix(b,exit,t),t);
      const road=nav.roadPoint(p[0],p[2]);
      if (road) turn.push(road);
    }
    result.push(...(turn.length===4?turn:[b]));
  }
  result.push(path.at(-1)!.point);
  return result;
}

function carRoute(nav: NpcNavigation,origin: Node,targetX: number,targetZ: number,profile: Profile,seed: number) {
  const {point,approach}=nav.parking(origin)!;
  const forward=point.map((v,i)=>v-approach[i]);
  function aligned(dx: number,dz: number,yaw: number) {
    return dx*Math.sin(yaw)+dz*Math.cos(yaw)>=-.2*Math.hypot(dx,dz);
  }
  const exitYaw=Math.atan2(forward[0],forward[2]);
  const dx=targetX-origin.point[0],dz=targetZ-origin.point[2];
  for (const angle of [0,1.35,-1.35,Math.PI]) {
    const x=origin.point[0]+dx*Math.cos(angle)-dz*Math.sin(angle);
    const z=origin.point[2]+dx*Math.sin(angle)+dz*Math.cos(angle);
    const score=(n: Node)=>Math.hypot(n.point[0]-x,n.point[2]-z);
    const candidates=nav.roadsNear(x,z,180).filter(n=>distance(n.point,origin.point)>=190)
      .sort((a,b)=>score(a)-score(b)).filter(n=>nav.parking(n)).slice(0,7);
    for (const goal of candidates) {
      const path=nav.route(origin,goal,profile,seed);
      if (!path || path.length<2) continue;
      const first=path[1].point,last=path.at(-2)!.point,end=goal.point;
      if (!aligned(first[0]-origin.point[0],first[2]-origin.point[2],exitYaw) ||
          !aligned(end[0]-last[0],end[2]-last[2],nav.parking(goal)!.yaw)) continue;
      if (path.some((node,i)=>{
        if (i===0 || i===path.length-1) return false;
        const [x,,z]=node.point,[ax,,az]=path[i-1].point,[bx,,bz]=path[i+1].point;
        return (x-ax)*(bx-x)+(z-az)*(bz-z)<-.8*Math.hypot(x-ax,z-az)*Math.hypot(bx-x,bz-z);
      })) continue;
      return path;
    }
  }
}

function footPoints(path: readonly Node[]) {
  const points=[path[0].point];
  for (let i=1;i<path.length-1;i++) {
    const a=path[i-1].point,b=path[i].point,c=path[i+1].point;
    if (Math.abs(a[0]+c[0]-2*b[0])>.001 || Math.abs(a[2]+c[2]-2*b[2])>.001 ||
        Math.abs(a[1]+c[1]-2*b[1])>.00001) points.push(b);
  }
  if (path.length>1) points.push(path.at(-1)!.point);
  return points;
}

type Cycle = {legs:Leg[];reservations:Reservation[];endTick:number;endAnchor:string;heading:number};

export function deriveNpcCycle(nav: NpcNavigation, scenario: NpcSeed): Cycle|undefined {
  if (!scenario || typeof scenario!=='object' || scenario.navigation!==nav.version || !Number.isSafeInteger(scenario.personality) ||
      !Number.isSafeInteger(scenario.startTick) || scenario.startTick<0 ||
      !Number.isSafeInteger(scenario.seed) || scenario.seed<0 || scenario.seed>0xffffffff ||
      (scenario.wait!==undefined&&(!Number.isSafeInteger(scenario.wait)||scenario.wait<SCHEDULE_STEP||scenario.wait>4800)) ||
      typeof scenario.anchor!=='string' || typeof scenario.home!=='string' || typeof scenario.id!=='string' || !scenario.id) return;
  const profile=profiles[scenario.personality], origin=nav.node(scenario.anchor), home=nav.node(scenario.home);
  if (!profile || !origin || !home || origin.id[0]!==home.id[0] ||
      origin.id.startsWith('r/')!==(profile.travel==='drive')) return;
  if (scenario.crowd!==undefined && (scenario.crowd!==true || profile.travel!=='walk' ||
      scenario.anchor!==scenario.home || !scenario.seed || scenario.wait!==undefined)) return;
  const parked=profile.travel==='drive'?nav.parking(origin):undefined;
  if (profile.travel==='drive'&&!parked) return;
  if (!scenario.seed) return waitingCycle(origin,scenario.startTick,profile.travel,parked?.point,parked?.yaw);
  const rng=random(scenario.seed);
  let time=scenario.startTick, walked=0, heading=0, node=origin;
  const legs: Leg[]=[], reservations: Reservation[]=[];
  function addLeg(a: Point,b: Point,mode: Mode,speed: number,hold=0,door?: string,backing?: true) {
    const length=distance(a,b);
    const duration=hold||Math.ceil(length*1000/(speed*STEP_MS));
    if (!duration) return;
    if (length) heading=Math.atan2((b[0]-a[0])*(backing?-1:1),(b[2]-a[2])*(backing?-1:1));
    const pitch=length?(backing?1:-1)*Math.atan2(b[1]-a[1],Math.hypot(b[0]-a[0],b[2]-a[2])):0;
    const leg={a,b,mode,from:time,until:time+duration,distance:walked,length,yaw:heading,pitch,into:0,out:0,door,backing};
    const previous=legs.at(-1);
    if (previous) {
      const delta=leg.yaw-previous.yaw;
      const turn=Math.atan2(Math.sin(delta),Math.cos(delta));
      if (length) previous.out=turn;
      if (previous.length) leg.into=-turn;
    }
    legs.push(leg);
    time+=duration;
    walked+=length;
  }
  const car=profile.travel==='drive', cruise=car?6+rng()*4:LOCOMOTION_SPEEDS.walk*(.9+rng()*.2);
  const activities=car?1:2+Math.floor(rng()*3);
  const carPoint=parked;
  const favorites=nav.visits.filter(v=>distance(home.point,v.node.point)<185)
    .sort((a,b)=>(hash(a.id,hash(scenario.id))%101+distance(home.point,a.node.point)*.4)-
      (hash(b.id,hash(scenario.id))%101+distance(home.point,b.node.point)*.4)).slice(0,3);
  // Cycles carry a bounded number of activities and start their successor at the final node.
  for (let activity=0;activity<activities;activity++) {
    let visit=rng()<profile.indoors?favorites[Math.floor(rng()*favorites.length)]:undefined;
    const radius=car?310+rng()*370:24+rng()*70;
    const angle=rng()*Math.PI*2;
    const x=node.point[0]*.62+home.point[0]*.38+Math.cos(angle)*radius;
    const z=node.point[2]*.62+home.point[2]*.38+(Math.sin(angle)+profile.north*.65)*radius;
    const goal=visit?.node??(car?undefined:nav.findFoot(x,z));
    const routeSeed=Math.floor(rng()*4294967296);
    let path=car?carRoute(nav,node,x,z,profile,routeSeed):goal?nav.route(node,goal,profile,routeSeed,scenario.crowd?520:undefined):undefined;
    if (!path && visit) {
      visit=undefined;
      const goal=nav.findFoot(x,z);
      if (goal) path=nav.route(node,goal,profile,routeSeed,scenario.crowd?520:undefined);
    }
    if (!path) continue;
    const points=car?curvedRoad(path,nav):footPoints(path);
    if (car && carPoint) {
      addLeg(carPoint.point,carPoint.approach,'drive',2.8,0,undefined,true);
      addLeg(carPoint.approach,points[0],'drive',3,0,undefined,true);
    }
    const running=!car&&rng()<profile.running;
    for (let i=1;i<points.length;i++) addLeg(points[i-1],points[i],car?'drive':running?'run':'walk',running?LOCOMOTION_SPEEDS.run:cruise);
    node=path.at(-1)!;
    if (visit) {
      const pathInside=visit.paths[Math.floor(rng()*visit.paths.length)];
      const pause=Math.floor(150+rng()*480);
      const enter=time;
      for (let i=1;i<pathInside.length;i++) addLeg(pathInside[i-1],pathInside[i],'walk',LOCOMOTION_SPEEDS.walk*.85,0,i<=2?visit.id:undefined);
      addLeg(pathInside.at(-1)!,pathInside.at(-1)!,'idle',1,pause);
      for (let i=pathInside.length-1;i>0;i--) addLeg(pathInside[i],pathInside[i-1],'walk',LOCOMOTION_SPEEDS.walk*.85,0,i<=2?visit.id:undefined);
      reservations.push({id:visit.id,from:enter,until:time});
    }
    if (!car) addLeg(node.point,node.point,'idle',1,Math.floor(75+rng()*260));
  }
  if (car && legs.length) {
    const lot=nav.parking(node)!;
    addLeg(node.point,lot.approach,'drive',3);
    addLeg(lot.approach,lot.point,'drive',2.8);
  }
  if (!legs.length) return waitingCycle(origin,scenario.startTick,profile.travel,parked?.point,parked?.yaw);
  if (car) {
    time=scenario.startTick;
    let wheel=0;
    for (const leg of legs) {
      const duration=Math.max(leg.until-leg.from,Math.ceil(Math.max(Math.abs(leg.into),Math.abs(leg.out))*40));
      leg.from=time;
      leg.until=time+=duration;
      leg.wheelStart=wheel;
      wheel+=leg.length*(leg.backing?-1:1);
    }
  }
  const cycle={legs,reservations,endTick:time,endAnchor:node.id,heading};
  return scenario.crowd?closeWalkingCycle(nav,scenario,cycle):scenario.wait?withDepartureWait(cycle,scenario.wait):cycle;
}

function withDepartureWait(cycle:Cycle,wait:number):Cycle {
  const first=cycle.legs[0];
  const hold:Leg={...first,b:first.a,until:first.from+wait,mode:first.mode==='drive'?'drive':'idle',length:0,into:0,out:0,door:undefined};
  const legs=[hold,...cycle.legs.map(leg=>({...leg,from:leg.from+wait,until:leg.until+wait}))];
  return {...cycle,legs,endTick:cycle.endTick+wait,
    reservations:cycle.reservations.map(r=>({...r,from:r.from+wait,until:r.until+wait}))};
}

function closeWalkingCycle(nav: NpcNavigation,recipe: NpcSeed,cycle: Cycle): Cycle {
  const home=nav.node(recipe.home)!, end=nav.node(cycle.endAnchor)!;
  if (end===home) return cycle;
  const path=nav.route(end,home,profiles[recipe.personality],recipe.seed,360);
  const points=path?footPoints(path):
    cycle.legs.filter(leg=>leg.length && !cycle.reservations.some(visit=>visit.from<=leg.from&&leg.until<=visit.until))
      .map(leg=>leg.a).reverse();
  const legs=[...cycle.legs];
  let from=cycle.endTick,a=end.point,walked=legs.at(-1)!.distance+legs.at(-1)!.length;
  for (const b of points) {
    const length=distance(a,b);
    if (!length) continue;
    const until=from+Math.ceil(length*1000/(LOCOMOTION_SPEEDS.walk*STEP_MS));
    const yaw=Math.atan2(b[0]-a[0],b[2]-a[2]);
    const pitch=-Math.atan2(b[1]-a[1],Math.hypot(b[0]-a[0],b[2]-a[2]));
    legs.push({a,b,mode:'walk',from,until,distance:walked,length,yaw,pitch,into:0,out:0});
    from=until;
    walked+=length;
    a=b;
  }
  return {legs,reservations:cycle.reservations,endTick:from,endAnchor:home.id,heading:legs.at(-1)!.yaw};
}

function outdoorCycle(cycle: Cycle): Cycle {
  if (!cycle.reservations.length) return cycle;
  let skipped=0,walked=0;
  const legs: Leg[]=[];
  for (const leg of cycle.legs) {
    if (cycle.reservations.some(visit=>visit.from<=leg.from&&leg.until<=visit.until)) {
      skipped+=leg.until-leg.from;
      continue;
    }
    legs.push({...leg,from:leg.from-skipped,until:leg.until-skipped,distance:walked});
    walked+=leg.length;
  }
  return {...cycle,legs,reservations:[],endTick:cycle.endTick-skipped};
}

export function npcPose(cycle: Cycle, tick: number) {
  if (!Number.isFinite(tick)) return;
  const {legs}=cycle;
  let low=0, high=legs.length-1;
  while (low<high) {
    const mid=(low+high)>>1;
    if (tick<legs[mid].until) high=mid;
    else low=mid+1;
  }
  const {a,b,from,until,mode,distance:travel,door,length,yaw,pitch,into,out}=legs[low];
  const t=Math.max(0,Math.min(1,(tick-from)/(until-from)));
  const previous=legs[low-1],next=legs[low+1];
  const doorLeg=door?legs[low]:next?.door&&next.from-tick<=36?next:
    previous?.door&&tick-previous.until<24?previous:undefined;
  const doorOpen=doorLeg?Math.max(0,Math.min(1,1+(tick-doorLeg.from)/36,1+(doorLeg.until-tick)/24)):0;
  return {point:mix(a,b,t), yaw:yaw+(t<.5?into*(.5-t):out*(t-.5)), mode,
    distance:travel+length*t, wheelDistance:(legs[low].wheelStart??travel)+length*t*(legs[low].backing?-1:1), speed:length*1000/((until-from)*STEP_MS), pitch,
    steering:Math.max(-.48,Math.min(.48,(out-into)*.6)), door:doorLeg?.door, doorOpen};
}

export type NpcCrowd = { readonly recipe: NpcSeed; readonly count: number; readonly slots: readonly number[] };
const SCHEDULE_STEP=40;
const SCHEDULE_PERIOD=14400;
const SCHEDULE_SLOTS=SCHEDULE_PERIOD/SCHEDULE_STEP;

function trackPeriod(cycle:Cycle) {
  const span=cycle.endTick-cycle.legs[0].from;
  return span<4157?3600:span<5879?4800:span<10182?7200:14400;
}

export function crowdTrack(full:Cycle,outdoors:readonly Cycle[],group:NpcCrowd,slot:number) {
  const track=Math.floor(group.slots[slot]/SCHEDULE_SLOTS);
  return track?outdoors[track-1]:full;
}

export function crowdTiming(cycle:Cycle,group:NpcCrowd,slot:number) {
  const departure=(group.slots[slot]%SCHEDULE_SLOTS)*SCHEDULE_STEP, start=cycle.legs[0].from, period=trackPeriod(cycle);
  return {phase:(((start-departure)%period)+period)%period/period,pace:(cycle.endTick-start)/period};
}

export function sampleNpc(cycle: Cycle,tick: number,phase?: number,pace=1) {
  if (phase===undefined) return npcPose(cycle,tick);
  const start=cycle.legs[0].from, span=cycle.endTick-start;
  const elapsed=(tick-start)*pace+phase*span;
  const position=((elapsed%span)+span)%span;
  const pose=npcPose(cycle,start+position);
  return pose && {...pose,speed:pose.speed*pace};
}

export function spreadWalkLeg(nav: NpcNavigation,a: Point,b: Point,sign: number,fraction: number,reach: number) {
  const dx=b[0]-a[0],dz=b[2]-a[2],length=Math.hypot(dx,dz);
  if (length<9) return;
  const center=mix(a,b,fraction);
  for (const scale of [1,.55]) {
    const offset=Math.min(reach,length*.6)*scale*sign;
    const bend=nav.walkOffset(center,center[0]+dz/length*offset,center[2]-dx/length*offset);
    if (!bend) continue;
    const safe=(p: Point,q: Point,u: Point,v: Point)=>{
      const steps=Math.ceil(distance(p,q)/.8);
      for (let i=1;i<=steps;i++) {
        const t=i/steps,point=mix(p,q,t);
        if (!nav.walkOffset(mix(u,v,t),point[0],point[2])) return false;
      }
      return true;
    };
    if (safe(a,bend,a,center)&&safe(bend,b,center,b)) return bend;
  }
}

function outdoorTracks(nav: NpcNavigation,full: Cycle,recipe: NpcSeed) {
  const center=outdoorCycle(full);
  const tracks=[center];
  const rng=random(recipe.seed);
  const root=nav.node(recipe.home)!;
  const tree=nav.walkingTree(root);
  const walkable=[...tree.keys()].filter(node=>node.cost!==3.2);
  const starts=[root];
  const [x,,z]=root.point;
  const profile=profiles[recipe.personality];
  const direction=rng()*2*Math.PI;
  function pick(x:number,z:number,away:readonly Node[],minimum:number) {
    let result:Node|undefined,best=Infinity;
    for (const node of walkable) {
      if (away.some(other=>distance(other.point,node.point)<minimum)) continue;
      const score=Math.hypot(node.point[0]-x,node.point[2]-z)+node.cost*2;
      if (score<best) {result=node;best=score;}
    }
    return result;
  }
  function treePath(a:Node,b:Node) {
    const left:Node[]=[],right:Node[]=[];
    for (let node:Node|null=a;node;node=tree.get(node)??null) left.push(node);
    for (let node:Node|null=b;node;node=tree.get(node)??null) {
      const join=left.indexOf(node);
      if (join>=0) return [...left.slice(0,join+1),...right.reverse()];
      right.push(node);
    }
    throw new Error('Disconnected pedestrian tree');
  }
  // Independently choose several local itineraries, keeping the expensive search shared by their members.
  for (let variant=0;variant<6&&tracks.length<3;variant++) {
    const angle=direction+variant*2.399963;
    const radius=19+rng()*28;
    const home=pick(x+Math.sin(angle)*radius,z+Math.cos(angle)*radius,starts,10);
    if (!home) continue;
    const stops=[home];
    for (const turn of [-.56,.88]) {
      const reach=30+rng()*32;
      const node=pick(x+Math.sin(angle+turn)*reach,z+Math.cos(angle+turn)*reach,stops,15);
      if (node) stops.push(node);
    }
    if (stops.length<3) continue;
    stops.push(home);
    const legs:Leg[]=[];
    const visited=new Set<Node>();
    let time=recipe.startTick,walked=0;
    for (let i=1;i<stops.length;i++) {
      const seed=Math.floor(rng()*0xffffffff);
      const path=nav.route(stops[i-1],stops[i],profile,seed,200,visited)??treePath(stops[i-1],stops[i]);
      for (const node of path.slice(0,-1)) visited.add(node);
      const points=footPoints(path);
      const run=rng()<profile.running*.65,speed=run?LOCOMOTION_SPEEDS.run:LOCOMOTION_SPEEDS.walk*(.9+rng()*.2);
      for (let j=1;j<points.length;j++) {
        const a=points[j-1],b=points[j];
        const bend=spreadWalkLeg(nav,a,b,variant%2?1:-1,.35+rng()*.3,8+rng()*7);
        const route=bend?[a,bend,b]:[a,b];
        for (let k=1;k<route.length;k++) {
          const p=route[k-1],q=route[k],length=distance(p,q);
          const until=time+Math.ceil(length*1000/(speed*STEP_MS));
          const yaw=Math.atan2(q[0]-p[0],q[2]-p[2]);
          legs.push({a:p,b:q,from:time,until,length,distance:walked,mode:run?'run':'walk',yaw,
            pitch:0,into:0,out:0});
          time=until;
          walked+=length;
        }
      }
      const end=points.at(-1)!;
      const until=time+Math.floor(40+rng()*240),yaw=legs.at(-1)!.yaw;
      legs.push({a:end,b:end,from:time,until,length:0,distance:walked,mode:'idle',yaw,pitch:0,into:0,out:0});
      time=until;
    }
    if (legs.at(-1)?.b!==home.point || walked<50) continue;
    for (let i=1;i<legs.length;i++) {
      const a=legs[i-1],b=legs[i],difference=b.yaw-a.yaw;
      const turn=Math.atan2(Math.sin(difference),Math.cos(difference));
      a.out=turn;
      b.into=-turn;
    }
    starts.push(home);
    tracks.push({legs,reservations:[],endTick:time,endAnchor:home.id,heading:legs.at(-1)!.yaw});
  }
  return tracks;
}

export function crowdCycles(nav: NpcNavigation,group: NpcCrowd) {
  const full=deriveNpcCycle(nav,group.recipe);
  return full && {full,outdoors:outdoorTracks(nav,full,group.recipe)};
}

type Entry = { seed: NpcSeed; cycle: Cycle; keys: Set<string>; traffic: Map<string,TrafficSegment[]>; schedule:StreetBooking; car:boolean };
type Presence = { entry: Entry; from: number; until: number };
export type NpcSnapshot = { readonly tick: number; readonly scenarios: readonly NpcSeed[]; readonly crowds: readonly NpcCrowd[] };

type TrafficSegment = Pick<Leg,'a'|'b'|'from'|'until'> & Partial<Pick<Leg,'yaw'|'into'|'out'>>;
const CAR_CLEARANCE=5.9;

function trafficPosition(leg: TrafficSegment,tick: number) {
  return leg.until===Infinity?leg.a:mix(leg.a,leg.b,(tick-leg.from)/(leg.until-leg.from));
}

function trafficHeading(leg: TrafficSegment,tick: number) {
  const yaw=leg.yaw??Math.atan2(leg.b[0]-leg.a[0],leg.b[2]-leg.a[2]);
  if (leg.until===Infinity) return yaw;
  const t=(tick-leg.from)/(leg.until-leg.from);
  return yaw+(t<.5?(leg.into??0)*(.5-t):(leg.out??0)*(t-.5));
}

export function trafficConflict(a: TrafficSegment,b: TrafficSegment) {
  const from=Math.max(a.from,b.from),until=Math.min(a.until,b.until);
  if (until<=from) return false;
  const p=trafficPosition(a,from),q=trafficPosition(b,from),end=trafficPosition(a,until),otherEnd=trafficPosition(b,until);
  if (apart(p,end,q,otherEnd)) return false;
  const cuts=[from,until];
  for (const leg of [a,b]) {
    const mid=(leg.from+leg.until)/2;
    if ((leg.into||leg.out) && mid>from && mid<until) cuts.push(mid);
  }
  cuts.sort((x,y)=>x-y);
  for (let i=1;i<cuts.length;i++) {
    const start=cuts[i-1],end=cuts[i];
    const ap=trafficPosition(a,start),bp=trafficPosition(b,start);
    const aq=trafficPosition(a,end),bq=trafficPosition(b,end);
    if (apart(ap,aq,bp,bq)) continue;
    const radius=(leg:TrafficSegment)=>1.29+1.53*(1-Math.cos((trafficHeading(leg,end)-trafficHeading(leg,start))/2));
    const ar=radius(a),br=radius(b);
    if (sweptDiscs(carBody(ap,trafficHeading(a,start),ar),carBody(aq,trafficHeading(a,end),ar),
      carBody(bp,trafficHeading(b,start),br),carBody(bq,trafficHeading(b,end),br))) return true;
  }
  return false;
}

function trafficCells(leg: TrafficSegment,use: (key: string)=>void,pad=0) {
  const {a,b}=leg;
  cells(Math.min(a[0],b[0])-pad,Math.max(a[0],b[0])+pad,
    Math.min(a[2],b[2])-pad,Math.max(a[2],b[2])+pad,use);
}

function trafficSegments(cycle: Cycle) {
  if (cycle.legs[0].mode!=='drive') return [];
  const point=cycle.legs.at(-1)!.b;
  // Reserve the terminal point until the authority commits a successor.
  return [...cycle.legs,{a:point,b:point,from:cycle.endTick,until:Infinity,yaw:cycle.heading}];
}

type StreetBooking = {pattern:Float64Array;terminal:Uint32Array};

export function createStreetSchedule(bounds:NpcNavigation['bounds']) {
  const size=1, minX=bounds.minX-16,minZ=bounds.minZ-16;
  const stride=Math.ceil((bounds.maxZ-minZ+16)/size);
  const ambient=new Map<number,Uint32Array>();
  type Row = {counts:Uint8Array;used:number};
  const people=new Map<number,Row>(),cars=new Map<number,Row>();
  const parkedPeople=new Map<number,number>(),parkedCars=new Map<number,number>();
  function raster(legs:readonly TrafficSegment[],car:boolean,origin:number,pace:number,repeats:number) {
    const pieces=new Set<number>();
    function cover(ax:number,az:number,bx:number,bz:number,radius:number,slot:number) {
      for (let x=Math.floor((Math.min(ax,bx)-radius-minX)/size);x<=Math.floor((Math.max(ax,bx)+radius-minX)/size);x++)
        for (let z=Math.floor((Math.min(az,bz)-radius-minZ)/size);z<=Math.floor((Math.max(az,bz)+radius-minZ)/size);z++)
          pieces.add((x*stride+z)*SCHEDULE_SLOTS+slot);
    }
    const duration=(legs.at(-1)!.until-origin)/pace;
    for (let i=0;i<repeats;i++) for (const leg of legs) {
      const from=(leg.from-origin)/pace+i*duration,until=(leg.until-origin)/pace+i*duration;
      const first=Math.floor(from/SCHEDULE_STEP),last=Math.floor(until/SCHEDULE_STEP);
      for (let bucket=first;bucket<=last;bucket++) {
        const offset=i*duration;
        const a=Math.max(from,bucket*SCHEDULE_STEP),b=Math.min(until,(bucket+1)*SCHEDULE_STEP);
        const ta=(a-offset)*pace+origin,tb=(b-offset)*pace+origin;
        const p=trafficPosition(leg,ta),q=trafficPosition(leg,tb);
        const slot=((bucket%SCHEDULE_SLOTS)+SCHEDULE_SLOTS)%SCHEDULE_SLOTS;
        if (!car) {cover(p[0],p[2],q[0],q[2],.34,slot);continue;}
        const mid=(leg.from+leg.until)/2;
        const cuts=(leg.into||leg.out)&&mid>ta&&mid<tb?[ta,mid,tb]:[ta,tb];
        for (let j=1;j<cuts.length;j++) {
          const lo=cuts[j-1],hi=cuts[j],start=trafficHeading(leg,lo),end=trafficHeading(leg,hi);
          const radius=1.29+1.53*(1-Math.cos((end-start)/2));
          const starts=carBody(trafficPosition(leg,lo),start,radius),ends=carBody(trafficPosition(leg,hi),end,radius);
          for (let k=0;k<starts.length;k++) cover(starts[k].x,starts[k].z,ends[k].x,ends[k].z,radius,slot);
        }
      }
    }
    return Float64Array.from(pieces);
  }
  function conflicts(pattern:Float64Array,shift:number,car=false) {
    for (const piece of pattern) {
      const key=Math.floor(piece/SCHEDULE_SLOTS),slot=(piece%SCHEDULE_SLOTS+shift)%SCHEDULE_SLOTS;
      if ((ambient.get(key)?.[slot>>>5]??0)&(1<<(slot&31))) return true;
      if (people.get(key)?.counts[slot] || parkedPeople.has(key) ||
          (!car&&(cars.get(key)?.counts[slot] || parkedCars.has(key)))) return true;
    }
    return false;
  }
  function markAmbient(pattern:Float64Array,shift:number) {
    for (const piece of pattern) {
      const key=Math.floor(piece/SCHEDULE_SLOTS),slot=(piece%SCHEDULE_SLOTS+shift)%SCHEDULE_SLOTS;
      let bits=ambient.get(key);
      if (!bits) ambient.set(key,bits=new Uint32Array(Math.ceil(SCHEDULE_SLOTS/32)));
      bits[slot>>>5]|=1<<(slot&31);
    }
  }
  return {
    template(cycle:Cycle) {
      const start=cycle.legs[0].from,period=trackPeriod(cycle);
      return raster(cycle.legs,false,start,(cycle.endTick-start)/period,SCHEDULE_PERIOD/period);
    },
    detailed(cycle:Cycle,car:boolean) {
      const tail=cycle.legs.at(-1)!;
      const stay={a:tail.b,b:tail.b,from:0,until:1,yaw:tail.yaw};
      return {pattern:raster(cycle.legs,car,0,1,1),
        terminal:Uint32Array.from(raster([stay],car,0,1,1),piece=>Math.floor(piece/SCHEDULE_SLOTS))};
    },
    conflicts,
    conflictsDetailed(booking:StreetBooking,car:boolean,shift=0) {
      for (const key of booking.terminal) {
        if (ambient.has(key)||people.has(key)||parkedPeople.has(key)||
            (!car&&(cars.has(key)||parkedCars.has(key)))) return true;
      }
      return conflicts(booking.pattern,shift,car);
    },
    book(pattern:Float64Array,desired:number) {
      for (let trial=0;trial<20;trial++) {
        const shift=(desired+trial*31)%SCHEDULE_SLOTS;
        if (conflicts(pattern,shift)) continue;
        markAmbient(pattern,shift);
        return shift;
      }
    },
    change(booking:StreetBooking,car:boolean,delta:1|-1) {
      const fixed=car?parkedCars:parkedPeople;
      for (const key of booking.terminal) {
        const count=(fixed.get(key)??0)+delta;
        if (count) fixed.set(key,count); else fixed.delete(key);
      }
      const index=car?cars:people;
      for (const piece of booking.pattern) {
        const key=Math.floor(piece/SCHEDULE_SLOTS),slot=piece%SCHEDULE_SLOTS;
        let row=index.get(key);
        if (!row) index.set(key,row={counts:new Uint8Array(SCHEDULE_SLOTS),used:0});
        row.counts[slot]+=delta;
        row.used+=delta;
        if (!row.used) index.delete(key);
      }
    },
  };
}

export function createNpcAuthority(nav: NpcNavigation, startTick: number, population = 13900) {
  const detailed=Math.min(population,1200);
  const crowdTarget=population-detailed;
  const crowdSize=14;
  let crowdPopulation=0;
  type CrowdEntry = {group:NpcCrowd;full:Cycle;outdoors:Cycle[]};
  const crowds=new Map<string,CrowdEntry[]>();
  const entries: Entry[]=[];
  const grid=new Map<string,Presence[]>();
  const occupied=new Map<string,Reservation[]>();
  const traffic=new Map<string,TrafficSegment[]>();
  const schedule=createStreetSchedule(nav.bounds);
  let tick=startTick, nextDue=Infinity;
  function replace(seed: NpcSeed, previous?: Entry) {
    if (previous) {
      schedule.change(previous.schedule,previous.car,-1);
      for (const key of previous.keys) {
        const remaining=grid.get(key)?.filter(p=>p.entry!==previous);
        if (remaining?.length) grid.set(key,remaining); else grid.delete(key);
      }
      for (const [key,segments] of previous.traffic) {
        const removed=new Set(segments);
        const remaining=traffic.get(key)?.filter(leg=>!removed.has(leg));
        if (remaining?.length) traffic.set(key,remaining); else traffic.delete(key);
      }
      for (const r of previous.cycle.reservations) {
        const remaining=occupied.get(r.id)?.filter(p=>p!==r);
        if (remaining?.length) occupied.set(r.id,remaining); else occupied.delete(r.id);
      }
    }
    let cycle=deriveNpcCycle(nav,seed);
    if (!cycle) return;
    const overlaps=(candidate: Cycle)=>{
      if (candidate.reservations.some(r=>(occupied.get(r.id)??[])
        .some(o=>containsAt(o,r.from)||containsAt(r,o.from)))) return true;
      for (const leg of trafficSegments(candidate)) {
        let blocked=false;
        trafficCells(leg,key=>{
          if (!blocked) blocked=(traffic.get(key)??[]).some(other=>trafficConflict(leg,other));
        },CAR_CLEARANCE);
        if (blocked) return true;
      }
      return false;
    };
    const car=profiles[seed.personality].travel==='drive';
    let pattern=schedule.detailed(cycle,car);
    let blocked=overlaps(cycle)||schedule.conflictsDetailed(pattern,car);
    for (let i=0;i<2&&blocked;i++) {
      if (cycle.legs.at(-1)!.distance>0) {
        const jitter=hash(seed.id,seed.seed+i)%3;
        for (const slot of [2,5,9,14,20,27,36,46,57,69,82,96,112]) {
          const wait=(slot+jitter)*SCHEDULE_STEP;
          if (schedule.conflictsDetailed(pattern,car,wait/SCHEDULE_STEP)) continue;
          const shifted=withDepartureWait(cycle,wait);
          if (overlaps(shifted)) continue;
          const delayed=schedule.detailed(shifted,car);
          if (schedule.conflictsDetailed(delayed,car)) continue;
          seed={...seed,wait};
          cycle=shifted;
          pattern=delayed;
          blocked=false;
          break;
        }
        if (!blocked) break;
      }
      seed={...seed,seed:hash(`retry/${i}`,seed.seed)||1};
      cycle=deriveNpcCycle(nav,seed)!;
      pattern=schedule.detailed(cycle,car);
      blocked=overlaps(cycle)||schedule.conflictsDetailed(pattern,car);
    }
    if (blocked) {
      seed={...seed,seed:0};
      cycle=deriveNpcCycle(nav,seed)!;
      pattern=schedule.detailed(cycle,car);
      if (!previous && (overlaps(cycle)||schedule.conflictsDetailed(pattern,car))) return;
    }
    const entry: Entry={seed:Object.freeze(seed),cycle,keys:new Set(),traffic:new Map(),schedule:pattern,car};
    schedule.change(pattern,car,1);
    for (const leg of trafficSegments(cycle)) trafficCells(leg,key=>{
      add(entry.traffic,key,leg);
      add(traffic,key,leg);
    });
    for (const r of cycle.reservations) add(occupied,r.id,r);
    const coverage=new Map<string,Presence[]>();
    for (const {a,b,from,until} of cycle.legs) cells(Math.min(a[0],b[0]),Math.max(a[0],b[0]),
      Math.min(a[2],b[2]),Math.max(a[2],b[2]),key=>{
        const last=coverage.get(key)?.at(-1);
        if (last && last.until===from) last.until=until;
        else add(coverage,key,{entry,from,until});
      });
    const end=cycle.legs.at(-1)!.b;
    add(coverage,cellKey(Math.floor(end[0]/CELL),Math.floor(end[2]/CELL)),
      {entry,from:cycle.endTick,until:Infinity});
    for (const [key,intervals] of coverage) {
      for (const interval of intervals) add(grid,key,interval);
      entry.keys.add(key);
    }
    nextDue=Math.min(nextDue,cycle.endTick);
    return entry;
  }
  const divisions=16,{minX,minZ,maxX,maxZ}=nav.bounds;
  const width=(maxX-minX)/divisions,depth=(maxZ-minZ)/divisions;
  const rank=random(hash(nav.mapVersion));
  const districts=Array.from({length:divisions**2},(_,i)=>{
    const ix=i%divisions,iz=Math.floor(i/divisions);
    const x=minX+ix*width,z=minZ+iz*depth;
    const distance=Math.hypot((x+width/2-nav.spawn.x)/width,(z+depth/2-nav.spawn.z)/depth);
    const weight=1+.25*Math.max(0,1-distance/(divisions/2));
    const roads: Node[]=[];
    return {x,z,weight,tie:rank(),count:0,walkable:true,roads};
  });
  for (const node of nav.roadNodes) {
    const ix=Math.min(divisions-1,Math.floor((node.point[0]-minX)/width));
    const iz=Math.min(divisions-1,Math.floor((node.point[2]-minZ)/depth));
    districts[iz*divisions+ix].roads.push(node);
  }
  const initialAnchors=new Set<string>();
  function spawn(i: number,birth: number,local?:{x:number;z:number}) {
    const id=`npc/${i}`,rng=random(hash(id));
    const localDistance=(d:typeof districts[number])=>local?Math.hypot(d.x+width/2-local.x,d.z+depth/2-local.z):0;
    const ordered=[...districts].sort((a,b)=>localDistance(a)-localDistance(b)||a.count/a.weight-b.count/b.weight||a.tie-b.tie);
    let personality=i%3;
    const drives=crowdTarget>0?i%3!==2:i%3===0;
    let district=drives?ordered.find(d=>d.roads.length):undefined;
    let anchor: Node|undefined;
    if (district) {
      personality=3+Math.floor(rng()*2);
      while (district.roads.length) {
        const [road]=district.roads.splice(Math.floor(rng()*district.roads.length),1);
        if (!nav.parking(road)) continue;
        const entry=replace({id,personality,seed:1+Math.floor(rng()*0xfffffffe),anchor:road.id,
          home:road.id,startTick:birth,navigation:nav.version});
        if (!entry) continue;
        district.count++;
        entries.push(entry);
        return;
      }
      district=undefined;
      personality=i%3;
    }
    {
      for (const candidate of ordered) {
        if (!candidate.walkable) continue;
        const offset=Math.floor(rng()*121);
        // Visit all sample sites before giving up on a district with no dry, connected sites left.
        for (let j=0;j<121;j++) {
          const site=(offset+j*37)%121;
          const x=candidate.x+((site%11+.5)/11)*width;
          const z=candidate.z+((Math.floor(site/11)+.5)/11)*depth;
          const node=nav.findFoot(x,z);
          if (!node || initialAnchors.has(node.id)) continue;
          const [nx,,nz]=node.point;
          if (nx<candidate.x || nx>=candidate.x+width || nz<candidate.z || nz>=candidate.z+depth) continue;
          anchor=node;
          district=candidate;
          break;
        }
        if (anchor) break;
        candidate.walkable=false;
      }
    }
    if (!anchor || !district) return;
    district.count++;
    initialAnchors.add(anchor.id);
    const seed={id,personality,seed:1+Math.floor(rng()*0xfffffffe),anchor:anchor.id,home:anchor.id,startTick:birth,navigation:nav.version};
    const entry=replace(seed);
    if (!entry) return;
    entries.push(entry);
  }
  const coverage=new Map<string,number>();
  const available=[...nav.walkSites];
  const crowdRandom=random(hash(`crowds/${nav.mapVersion}`));
  function seedCrowd(birth:number,local?:{x:number;z:number}):void {
    if (!available.length) return;
    let chosen=-1,best=Infinity;
    const samples=local?available.length:Math.min(64,available.length);
    for (let i=0;i<samples;i++) {
      const index=local?i:Math.floor(crowdRandom()*available.length);
      const site=available[index];
      if (local && Math.hypot((site.x+.5)*WALK_COVERAGE_CELL-local.x,(site.z+.5)*WALK_COVERAGE_CELL-local.z)>110) continue;
      let density=(coverage.get(site.key)??0)*2;
      for (const [dx,dz] of [[-1,0],[1,0],[0,-1],[0,1]])
        density+=(coverage.get(cellKey(site.x+dx,site.z+dz))??0)*.25;
      const priority=(1+density)/Math.sqrt(Math.max(50,site.area))+crowdRandom()*.018;
      if (priority<best) {chosen=index;best=priority;}
    }
    if (chosen<0) return seedCrowd(birth);
    const site=available[chosen];
    available[chosen]=available.at(-1)!;
    available.pop();
    const offset=Math.floor(crowdRandom()*site.points.length);
    for (let attempt=0;attempt<site.points.length;attempt++) {
      const [x,,z]=site.points[(offset+attempt)%site.points.length];
      const anchor=nav.findFoot(x,z);
      if (!anchor || Math.floor(anchor.point[0]/WALK_COVERAGE_CELL)!==site.x ||
          Math.floor(anchor.point[2]/WALK_COVERAGE_CELL)!==site.z) continue;
      const id=`street/${site.key}`;
      const recipe:NpcSeed=Object.freeze({id,personality:hash(id)%3,crowd:true,
        seed:hash(id,hash(nav.mapVersion))||1,anchor:anchor.id,home:anchor.id,startTick:birth,navigation:nav.version});
      const full=deriveNpcCycle(nav,recipe)!;
      if (full.legs.at(-1)!.distance<55) return;
      const target=Math.min(crowdSize,crowdTarget-crowdPopulation);
      const outdoors=outdoorTracks(nav,full,recipe),slots:number[]=[];
      const tracks=[full,...outdoors],patterns=new Map<Cycle,Float64Array>();
      const assigned=tracks.map(()=>0);
      for (let slot=0;slot<target;slot++) {
        const preferred=slot%7===0?0:1+slot%outdoors.length;
        const order=tracks.map((_,i)=>i).sort((a,b)=>Number(b===preferred)-Number(a===preferred)||assigned[a]-assigned[b]);
        let booked=false;
        for (const i of order) {
          const track=tracks[i];
          let pattern=patterns.get(track);
          if (!pattern) {pattern=schedule.template(track);patterns.set(track,pattern);}
          const start=schedule.book(pattern,hash(id,slot+recipe.seed)%SCHEDULE_SLOTS);
          if (start===undefined) continue;
          slots.push(i*SCHEDULE_SLOTS+start);
          assigned[i]++;
          booked=true;
          break;
        }
        if (!booked) break;
      }
      const count=slots.length;
      if (!count) return;
      const group=Object.freeze({recipe,count,slots:Object.freeze(slots)});
      const value={group,full,outdoors},keys=new Set<string>();
      for (const track of tracks) {
        const period=track.endTick-track.legs[0].from;
        for (const leg of track.legs) {
          trafficCells(leg,key=>keys.add(key));
          const samples=Math.max(1,Math.ceil(leg.length/12));
          const share=count*(leg.until-leg.from)/(tracks.length*period*samples);
          for (let i=0;i<samples;i++) {
            const [x,,z]=mix(leg.a,leg.b,(i+.5)/samples);
            const key=cellKey(Math.floor(x/WALK_COVERAGE_CELL),Math.floor(z/WALK_COVERAGE_CELL));
            coverage.set(key,(coverage.get(key)??0)+share);
          }
        }
      }
      for (const key of keys) add(crowds,key,value);
      crowdPopulation+=count;
      return;
    }
  }
  function selectNearby<T>(x: number,z: number,radius: number,read: (key: string,selected: Set<T>)=>void) {
    const selected=new Set<T>();
    if (x>=minX-radius && x<=maxX+radius && z>=minZ-radius && z<=maxZ+radius)
      cells(x-radius,x+radius,z-radius,z+radius,key=>read(key,selected));
    return selected;
  }
  const nearby=(x: number,z: number)=>selectNearby<Entry>(x,z,TRAFFIC_RADIUS+8,(key,selected)=>{
    for (const p of grid.get(key)??[]) if (p.until>tick&&p.from<=tick+LEAD_TICKS) selected.add(p.entry);
  });
  const nearbyCrowds=(x: number,z: number)=>selectNearby<CrowdEntry>(x,z,NPC_RADIUS+8,(key,selected)=>{
    for (const entry of crowds.get(key)??[]) selected.add(entry);
  });

  let attempts=0,crowdAttempts=0,job=0;
  const needsResident=()=>entries.length<detailed && attempts<detailed*2;
  const needsCrowd=()=>crowdPopulation<crowdTarget && available.length>0;
  function birthResident(birth:number,local?:{x:number;z:number}) {
    spawn(attempts++,birth,local);
    if (!needsResident()) initialAnchors.clear();
  }
  function renew(entry:Entry,startTick:number) {
    const {id,personality,home,navigation}=entry.seed;
    return replace({id,personality,home,navigation,seed:hash(`${id}/${startTick}`,entry.seed.seed)||1,
      startTick,anchor:entry.cycle.endAnchor},entry)!;
  }
  return {
    population:()=>entries.length+crowdPopulation,
    planNext(current:number,initialOrigin:{x:number;z:number}|null) {
      tick=current;
      // Interleave births with renewals so a burst of expirations cannot starve new districts.
      const turn=job++%3;
      if (needsCrowd() && crowdAttempts<8 && initialOrigin) {
        seedCrowd(current,initialOrigin);
        crowdAttempts++;
        return true;
      }
      if (turn===0 && needsResident()) {birthResident(current,attempts<6?initialOrigin??undefined:undefined);return true;}
      if (turn===1 && needsCrowd()) {seedCrowd(current);return true;}
      if (current>=nextDue) {
        let earliest=-1;
        nextDue=Infinity;
        for (let i=0;i<entries.length;i++) {
          const end=entries[i].cycle.endTick;
          if (end>current || (earliest>=0 && entries[earliest].cycle.endTick<=end)) {
            nextDue=Math.min(nextDue,end);
          } else {
            if (earliest>=0) nextDue=Math.min(nextDue,entries[earliest].cycle.endTick);
            earliest=i;
          }
        }
        if (earliest>=0) {entries[earliest]=renew(entries[earliest],current);return true;}
      }
      if (needsResident()) {birthResident(current,attempts<6?initialOrigin??undefined:undefined);return true;}
      if (needsCrowd()) {seedCrowd(current);return true;}
      return false;
    },
    step(current: number) {
      tick=current;
      // Birth schedule stays deterministic across rendering cadences. Spread route generation over ticks.
      while (entries.length<detailed && attempts<detailed*2 && startTick+1+attempts*2<=tick) {
        birthResident(startTick+1+attempts*2);
      }
      while (crowdPopulation<crowdTarget && available.length && startTick+2+crowdAttempts*2<=tick) {
        seedCrowd(startTick+2+crowdAttempts*2);
        crowdAttempts++;
      }
      if (tick<nextDue) return;
      nextDue=Infinity;
      for (let i=0;i<entries.length;i++) {
        let entry=entries[i];
        while (tick>=entry.cycle.endTick) entry=renew(entry,entry.cycle.endTick);
        entries[i]=entry;
        nextDue=Math.min(nextDue,entry.cycle.endTick);
      }
    },
    snapshot(x: number,z: number): NpcSnapshot {
      return Object.freeze({tick,scenarios:Object.freeze([...nearby(x,z)].map(entry=>entry.seed)),
        crowds:Object.freeze([...nearbyCrowds(x,z)].map(entry=>entry.group))});
    },
    // The local presenter shares derived plans. A remote client can still rebuild from snapshot.scenarios.
    presentation(x: number,z: number) { return [...nearby(x,z)].map(({seed,cycle})=>({seed,cycle})); },
    crowdPresentation(x: number,z: number) { return [...nearbyCrowds(x,z)]; },
  };
}

function waitingCycle(anchor: Node,from: number,travel: Profile['travel'],point=anchor.point,yaw=0) {
  const until=from+(travel==='drive'?720:360);
  const leg: Leg={a:point,b:point,mode:travel==='drive'?'drive':'idle',from,until,distance:0,length:0,yaw,pitch:0,into:0,out:0};
  return {legs:[leg],reservations:[],endTick:until,endAnchor:anchor.id,heading:yaw};
}

type Body = {x:number;z:number;radius:number};

function carBody(point:Point,yaw:number,radius=1.29): Body[] {
  const [x,,z]=point,sx=Math.sin(yaw),sz=Math.cos(yaw);
  return [-1.53,0,1.53].map(offset=>({x:x+sx*offset,z:z+sz*offset,radius}));
}

function apart(a:Point,ae:Point,b:Point,be:Point) {
  if (Math.max(a[1],ae[1])+2.15<Math.min(b[1],be[1]) ||
      Math.max(b[1],be[1])+2.15<Math.min(a[1],ae[1])) return true;
  for (const i of [0,2]) {
    if (Math.max(a[i],ae[i])+CAR_CLEARANCE<Math.min(b[i],be[i]) ||
        Math.max(b[i],be[i])+CAR_CLEARANCE<Math.min(a[i],ae[i])) return true;
  }
  return false;
}

function sweptDiscs(start:Body[],end:Body[],otherStart:Body[],otherEnd:Body[]) {
  return start.some((p,i)=>otherStart.some((q,j)=>{
    const dx=p.x-q.x,dz=p.z-q.z,ex=end[i].x-otherEnd[j].x,ez=end[i].z-otherEnd[j].z;
    const ux=ex-dx,uz=ez-dz;
    const t=Math.max(0,Math.min(1,-(dx*ux+dz*uz)/(ux*ux+uz*uz||1)));
    return (dx+ux*t)**2+(dz+uz*t)**2<(p.radius+q.radius)**2;
  }));
}

