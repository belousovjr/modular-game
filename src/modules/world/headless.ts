import type { Rectangle, WorldPlacement, CitySource, CityMesh } from '../world-generation/headless.ts';

export type BuildingShape = 'rectangular' | 'round' | 'oval' | 'complex';

export interface BuildingProfile {
  readonly shape: BuildingShape;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly aspectRatio: number;
  /** World X/Y/Z and Babylon yaw. Local points below use X/Z in metres. */
  readonly origin: readonly number[];
  readonly yaw: number;
  readonly outline: readonly (readonly number[])[];
  readonly floorCount: number;
  readonly elevatorCount: number;
  readonly staircaseCount: number;
  readonly floorHeight: number;
  readonly facadeBase: number;
  readonly windowSlots: number;
  readonly facades: readonly {
    readonly start: readonly number[];
    readonly end: readonly number[];
    readonly windowColumns: number;
  }[];
  readonly entrance: {
    readonly wallIndex: number;
    readonly offset: number;
    readonly center: readonly number[];
    readonly base: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface BuildingInteriorSource {
  readonly id: string;
  readonly bounds: CitySource['bounds'];
  readonly profile: BuildingProfile;
  readonly facade: CityMesh;
}

export interface CollisionBox extends Rectangle { readonly id: string; readonly minY: number; readonly maxY: number; readonly outline?: readonly (readonly number[])[] }
export interface BuildingDoor {
  readonly id: string;
  readonly x: number; readonly y: number; readonly z: number;
  readonly tx: number; readonly tz: number;
  readonly width: number; readonly height: number;
}
export interface CollisionWorld {
  readonly bounds: Rectangle;
  readonly baseHeight: number;
  readonly slopeX: number;
  readonly blockers: readonly CollisionBox[];
  readonly pedestrianWalls?: readonly CollisionBox[];
  readonly pedestrianShells?: readonly string[];
  readonly doors?: readonly BuildingDoor[];
  readonly floors: readonly (Rectangle & { readonly elevation: number })[];
  readonly triangles?: readonly (readonly number[])[];
  readonly water?: {readonly level:number;readonly triangles:readonly (readonly number[])[]};
  readonly spawn: { readonly x: number; readonly z: number };
}

export function pedestrianBlockers(world: CollisionWorld): readonly CollisionBox[] {
  if (!world.pedestrianWalls?.length) return world.blockers;
  const replaced = new Set(world.pedestrianShells);
  return [...world.blockers.filter(blocker=>!replaced.has(blocker.id)),...world.pedestrianWalls];
}

const buildingPart=(x:number,y:number,z:number,w:number,h:number,d:number)=>({
  position:[x,y,z] as const,
  size:[w,h,d] as const,
});

export function steppedBuildingParts(profile:string,width:number,depth:number,height:number) {
  if(profile==='willis'){
    // Quantize shared edges before deriving centres and sizes.
    const edges=(span:number)=>{
      const modules=Math.max(3,Math.round(span/.25));
      const outer=modules*.125;
      const side=Math.round(modules/3)*.25;
      return [-outer,-outer+side,outer-side,outer];
    };
    const x=edges(width),z=edges(depth);
    return [.52,.72,.92,.72,1,.92,.52,.72,.52].map((scale,i)=>{
      const column=i%3,row=Math.floor(i/3);
      const h=snapCityMeasure(height*scale,.25);
      return buildingPart((x[column]+x[column+1])/2,h/2,(z[row]+z[row+1])/2,x[column+1]-x[column],h,z[row+1]-z[row]);
    });
  }
  if(profile==='trump'||profile==='wrigley'||profile==='tribune'){
    const ends=[0,.54,.84,1].map(scale=>snapCityMeasure(height*scale,.25));
    return [1,.72,.42].map((scale,i)=>
      buildingPart(0,(ends[i]+ends[i+1])/2,0,width*scale,ends[i+1]-ends[i],depth*scale));
  }
  return null;
}

export function steppedBuildingCrownParts(profile:string,width:number,depth:number,height:number) {
  if(profile==='wrigley'){
    const crownHeight=Math.max(.25,snapCityMeasure(height*.045,.25));
    return [buildingPart(0,snapCityMeasure(height,.25)+crownHeight/2,0,width*.24,crownHeight,depth*.24)];
  }
  if(profile==='tribune')return [-1,1].flatMap(x=>[-1,1].map(z=>
    buildingPart(x*width*.22,height*.97,z*depth*.22,width*.08,height*.12,depth*.08)));
  return [];
}

export const snapCityMeasure=(value:number,step:number)=>Math.round(value/step)*step;
export const TREE_TRUNK=Object.freeze({radius:.022,height:.72});

export function createCollisionWorld(placements: readonly WorldPlacement[], bounds: Rectangle, baseHeight: number, slopeX: number): CollisionWorld {
  const blockers: CollisionBox[] = [];
  let spawn = { x:10,z:12 }, spawnDistance = Infinity;
  const floors: (Rectangle & { elevation: number })[] = [];
  for (const p of placements) {
    const [x, y, z] = p.position;
    if (p.templateId === 'world/road' && p.parameters.width > 2 && p.parameters.depth > 2 && Math.hypot(x,z) < spawnDistance) {
      spawn = { x,z }; spawnDistance = Math.hypot(x,z);
    }
    if (p.templateId === 'world/building' || p.templateId === 'world/lamp') {
      const halfX = p.templateId === 'world/lamp' ? 0.15 : p.parameters.width / 2 + 0.3;
      const halfZ = p.templateId === 'world/lamp' ? 0.15 : p.parameters.depth / 2 + 0.3;
      blockers.push(Object.freeze({ id: p.key, minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ,
        minY: y - (p.parameters.foundation ?? 0.2), maxY: y + (p.parameters.height ?? 4.5) }));
    } else if (['world/sidewalk', 'world/curb', 'world/plaza'].includes(p.templateId)) {
      const halfX = (p.parameters.width ?? 6) * Math.cos(p.rotation[2]) / 2;
      const halfZ = (p.parameters.depth ?? 6) / 2;
      if (p.templateId === 'world/plaza') blockers.push(Object.freeze({ id: `${p.key}/monument`, minX:x-1,maxX:x+1,minZ:z-1,maxZ:z+1,minY:y,maxY:y+3 }));
      floors.push(Object.freeze({ minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ,
        elevation: p.templateId === 'world/curb' || p.templateId === 'world/plaza' ? 0.2 : 0.18 }));
    }
  }
  return Object.freeze({ bounds: Object.freeze({ ...bounds }), baseHeight, slopeX,
    blockers: Object.freeze(blockers), floors: Object.freeze(floors), spawn: Object.freeze(spawn) });
}

function pedestrianShells(city: CitySource, blockers: readonly CollisionBox[]) {
  const byId = new Map(city.colliders.map(collider => [collider.id,collider]));
  const levels = new Map(city.placements.map(placement => [placement.key,placement.position[1]]));
  const walls: CollisionBox[] = [], doors: BuildingDoor[] = [];
  const hollow = new Set<string>();
  for (const chunk of city.chunks) for (const detail of chunk.details ?? []) {
    const id = detail.id.split('/detail/')[1];
    const source = byId.get(id), base = levels.get(id);
    const panel = detail.meshes.find(mesh=>mesh.surface==='facade')?.positions;
    const skin = detail.meshes.find(mesh=>mesh.surface.endsWith('-detail'));
    if (!source || base===undefined || !panel || !skin) continue;
    const x=(panel[0]+panel[9])/2, z=(panel[2]+panel[11])/2, y=panel[1];
    const width=Math.hypot(panel[9]-panel[0],panel[11]-panel[2]), height=panel[4]-y;
    const tx=(panel[9]-panel[0])/width, tz=(panel[11]-panel[2])/width;
    const edges: {ax:number;az:number;bx:number;bz:number;length:number}[] = [];
    const p=skin.positions;
    for(let i=0;i+5<skin.indices.length;i+=3) {
      const [a,b,c,d]=[skin.indices[i],skin.indices[i+1],skin.indices[i+2],skin.indices[i+5]];
      if(b!==a+1||c!==a+2||d!==a+3||Math.abs(p[a*3+1]-base-.5)>.001||
        Math.abs(p[b*3+1]-source.maxY+.5)>.001||p[b*3+1]!==p[c*3+1]||p[a*3+1]!==p[d*3+1]) continue;
      const ax=p[a*3],az=p[a*3+2],bx=p[d*3],bz=p[d*3+2],length=Math.hypot(bx-ax,bz-az);
      if(length>.001)edges.push({ax,az,bx,bz,length});
    }
    const doorEdge=edges.findIndex(({ax,az,bx,bz,length})=>{
      const dx=(bx-ax)/length,dz=(bz-az)/length, along=(x-ax)*dx+(z-az)*dz;
      return Math.abs(dx*tx+dz*tz)>.999 && Math.abs((x-ax)*dz-(z-az)*dx)<.6 &&
        along>width/2 && length-along>width/2;
    });
    if (!width || !height || doorEdge<0) continue;
    const {minY,maxY}=source;
    doors.push({id,x,y,z,tx,tz,width,height});
    hollow.add(id);
    for(const [index,{ax,az,bx,bz,length}] of edges.entries()){
      const dx=(bx-ax)/length,dz=(bz-az)/length;
      function wall(from:number,to:number,minY:number){
        const x1=ax+dx*from,z1=az+dz*from,x2=ax+dx*to,z2=az+dz*to;
        const nx=dz*.125,nz=-dx*.125;
        const outline=[[x1+2*nx,z1+2*nz],[x2+2*nx,z2+2*nz],[x2-nx,z2-nz],[x1-nx,z1-nz]];
        walls.push({id:`${id}/wall/${index}/${from}`,outline,minY,maxY,
          minX:Math.min(...outline.map(p=>p[0])), maxX:Math.max(...outline.map(p=>p[0])),
          minZ:Math.min(...outline.map(p=>p[1])), maxZ:Math.max(...outline.map(p=>p[1]))});
      }
      if(index!==doorEdge){wall(0,length,minY);continue;}
      const along=(x-ax)*dx+(z-az)*dz, left=along-width/2, right=along+width/2;
      wall(0,left,minY);
      wall(right,length,minY);
      if (y+height < maxY) wall(left,right,y+height);
    }
  }
  const ids: string[] = [];
  for (const b of blockers) {
    if (!hollow.has(b.id.split('/court/')[0])) continue;
    ids.push(b.id);
    walls.push({...b,id:`${b.id}/ceiling`,minY:b.maxY-.5});
  }
  return {pedestrianWalls:walls,pedestrianShells:ids,doors};
}

export function cityCollision(city:CitySource):CollisionWorld {
  const triangles:(readonly number[])[]=[],water:(readonly number[])[]=[];
  for(const chunk of city.chunks)for(const mesh of chunk.meshes) {
    if(['bank','marking','facade','foundation','metal','roof'].includes(mesh.surface)||mesh.surface.startsWith('city-'))continue;
    for(let i=0;i<mesh.indices.length;i+=3) {
      const a=mesh.indices[i]*3,b=mesh.indices[i+1]*3,c=mesh.indices[i+2]*3;
      if(Math.abs((mesh.positions[b]-mesh.positions[a])*(mesh.positions[c+2]-mesh.positions[a+2])-(mesh.positions[c]-mesh.positions[a])*(mesh.positions[b+2]-mesh.positions[a+2]))<1e-8)continue;
      (mesh.surface==='water'?water:triangles).push(Object.freeze([mesh.positions[a],mesh.positions[a+1],mesh.positions[a+2],mesh.positions[b],mesh.positions[b+1],mesh.positions[b+2],mesh.positions[c],mesh.positions[c+1],mesh.positions[c+2]]));
    }
  }
  const rooftopBlockers:CollisionBox[]=[];
  for(const chunk of city.chunks)for(const detail of chunk.details??[]){
    const cap=detail.meshes.find(m=>m.surface==='roof');
    const walls=detail.meshes.find(m=>m.surface==='foundation');
    if(!cap||!walls)continue;
    // prepare-downtown emits one rectangular plant per detail, with a cap quad and four walls.
    const v=cap.positions;
    rooftopBlockers.push({id:`${detail.id}/roof-plant`,minX:v[0],maxX:v[6],minZ:v[2],maxZ:v[8],minY:walls.positions[1],maxY:v[1]});
  }
  const furniture=city.placements.flatMap(p=>{
    const size=p.templateId==='city/bench'?[3,.75,1.25]:p.templateId==='city/planter'?[5,2.5,.75]:p.templateId==='city/bollard'?[.5,.5,1]:null;
    if(!size)return [];
    const [x,y,z]=p.position, [width,depth,height]=size;
    const c=Math.cos(p.rotation[1]),s=Math.sin(p.rotation[1]);
    const outline=[[-width/2,-depth/2],[width/2,-depth/2],[width/2,depth/2],[-width/2,depth/2]].map(([u,v])=>[x+u*c+v*s,z-u*s+v*c]);
    return [{id:p.key,minX:Math.min(...outline.map(v=>v[0])),maxX:Math.max(...outline.map(v=>v[0])),minZ:Math.min(...outline.map(v=>v[1])),maxZ:Math.max(...outline.map(v=>v[1])),minY:y,maxY:y+height,outline}];
  });
  const trees=city.placements.filter(p=>p.templateId==='city/tree').map(p=>{
    const [x,y,z]=p.position;
    const radius=p.parameters.height*TREE_TRUNK.radius;
    return {id:p.key,minX:x-radius,maxX:x+radius,minZ:z-radius,maxZ:z+radius,minY:y,maxY:y+p.parameters.height*TREE_TRUNK.height};
  });
  const placements=new Map(city.placements.map(p=>[p.key,p]));
  const buildingBlockers=city.colliders.flatMap((source):CollisionBox[]=>{
    const placement=placements.get(source.id);
    if(placement){
      const {width,depth,height,foundation}=placement.parameters;
      const profile=placement.templateId.slice('city/'.length);
      const tiers=steppedBuildingParts(profile,width,depth,height);
      if(tiers){
        const [x,y,z]=placement.position;
        const angle=snapCityMeasure(placement.rotation[1],Math.PI/12),c=Math.cos(angle),s=Math.sin(angle);
        return [...tiers,buildingPart(0,-foundation/2,0,width,foundation,depth),
          ...steppedBuildingCrownParts(profile,width,depth,height)].map((part,index)=>{
          const [cx,cy,cz]=part.position.map(v=>snapCityMeasure(v,.125));
          const [w,h,d]=part.size.map(v=>Math.max(.25,snapCityMeasure(v,.25)));
          const outline=[[-w/2,-d/2],[w/2,-d/2],[w/2,d/2],[-w/2,d/2]]
            .map(([u,v])=>[x+(cx+u)*c+(cz+v)*s,z-(cx+u)*s+(cz+v)*c]);
          return {id:index===0?source.id:`${source.id}/volume/${index}`,
            minX:Math.min(...outline.map(p=>p[0])),maxX:Math.max(...outline.map(p=>p[0])),
            minZ:Math.min(...outline.map(p=>p[1])),maxZ:Math.max(...outline.map(p=>p[1])),
            minY:y+cy-h/2,maxY:y+cy+h/2,outline};
        });
      }
    }
    if(!source.parts)return [source];
    return source.parts.map((outline,index)=>({
      id:index===0?source.id:`${source.id}/court/${index}`,outline,minY:source.minY,maxY:source.maxY,
      minX:Math.min(...outline.map(p=>p[0])),maxX:Math.max(...outline.map(p=>p[0])),
      minZ:Math.min(...outline.map(p=>p[1])),maxZ:Math.max(...outline.map(p=>p[1])),
    }));
  });
  const blockers=[...buildingBlockers,...rooftopBlockers,...furniture,...trees,...city.placements.filter(p=>p.templateId==='world/lamp'||p.templateId==='city/signal').flatMap(p=>{
    const [x,y,z]=p.position;
    const pole={id:p.key,minX:x-.125,maxX:x+.125,minZ:z-.125,maxZ:z+.125,minY:y-.125,maxY:y+(p.templateId==='city/signal'?6.75:4.375)};
    return p.templateId==='world/lamp'?[pole,{id:`${p.key}/base`,minX:x-.25,maxX:x+.25,minZ:z-.25,maxZ:z+.25,minY:y-.125,maxY:y+.375}]:[pole];
  })];
  return Object.freeze({bounds:Object.freeze({...city.bounds}),baseHeight:-40,slopeX:0,spawn:Object.freeze({...city.spawn}),blockers,...pedestrianShells(city,buildingBlockers),floors:[],triangles:Object.freeze(triangles),water:{level:city.waterLevel,triangles:Object.freeze(water)}});
}
