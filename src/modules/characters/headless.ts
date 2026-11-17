import type { CollisionWorld, CollisionBox } from '../world/headless.ts';

export interface MoveCommand { readonly type: 'move'; readonly characterId: string; readonly sequence: number; readonly tick: number; readonly x: number; readonly z: number; readonly run: boolean; readonly jump: boolean; readonly facing?: number | null }
export interface VehicleCharacterFrame {
  readonly blocker: CollisionBox;
  readonly approach?: {readonly x:number;readonly z:number;readonly yaw:number;readonly vehicleId:string;readonly run:boolean;readonly align:boolean};
  readonly pose: {readonly x:number;readonly y:number;readonly z:number;readonly yaw:number;readonly vehicleId:string;readonly rotation?:readonly number[];readonly animation:'approaching'|'entering'|'driving'|'exiting'|'crawling'} | null;
  readonly release: {readonly x:number;readonly y:number;readonly z:number;readonly yaw:number} | null;
}
export interface CharacterSnapshot {
  readonly tick: number; readonly id: string; readonly ownerId: string;
  readonly x: number; readonly y: number; readonly z: number; readonly yaw: number;
  readonly vehicleId?:string;readonly vehicleRotation?:readonly number[];readonly vehicleAnimation?:'approaching'|'entering'|'driving'|'exiting'|'crawling';
  readonly grounded: boolean; readonly verticalSpeed: number; readonly airborneTicks: number; readonly landedTick: number;
  readonly moving: boolean; readonly running: boolean; readonly lastSequence: number;
}
export interface Receipt { readonly accepted: boolean; readonly reason: string }
const RADIUS = 0.35;
const HEIGHT = 1.8;
const CELL = 32;

export function createCharacterAuthority(world: CollisionWorld, startTick = 0) {
  return createCharacterAuthorityFactory(world)(startTick);
}

export function createCharacterAuthorityFactory(world: CollisionWorld) {
  if (![world.baseHeight, world.slopeX, world.spawn.x, world.spawn.z, world.baseHeight+world.slopeX*world.bounds.minX, world.baseHeight+world.slopeX*world.bounds.maxX, ...Object.values(world.bounds)].every(Number.isFinite) || Math.abs(world.slopeX) > 0.1 || world.bounds.minX >= world.bounds.maxX || world.bounds.minZ >= world.bounds.maxZ || world.blockers.length > 10000 || world.floors.length > 10000) throw new Error('Invalid character world');
  const cells = new Map<string, CollisionBox[]>();
  const triangles=new Map<string,{minX:number;maxX:number;minZ:number;maxZ:number;vertices:readonly number[]}[]>();
  const floors = new Map<string, (CollisionWorld['floors'][number])[]>();
  let entries = 0;
  function index<T extends { minX: number; maxX: number; minZ: number; maxZ: number }>(map: Map<string, T[]>, item: T) {
    if (![item.minX, item.maxX, item.minZ, item.maxZ].every(Number.isFinite) || item.minX >= item.maxX || item.minZ >= item.maxZ) throw new Error('Invalid collision bounds');
    const minX = Math.floor((item.minX - RADIUS) / CELL), maxX = Math.floor((item.maxX + RADIUS) / CELL);
    const minZ = Math.floor((item.minZ - RADIUS) / CELL), maxZ = Math.floor((item.maxZ + RADIUS) / CELL);
    entries += (maxX - minX + 1) * (maxZ - minZ + 1);
    if (entries > 1000000 || (maxX - minX + 1) * (maxZ - minZ + 1) > 4096 || ![minX,maxX,minZ,maxZ].every(Number.isSafeInteger)) throw new Error('Collision grid budget exceeded');
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const key = `${x}/${z}`; const list = map.get(key);
      if (list) list.push(item); else map.set(key, [item]);
    }
  }
  for (const b of world.blockers) {
    if (![b.minY,b.maxY].every(Number.isFinite) || b.maxY <= b.minY) throw new Error('Invalid collision height');
    if(b.outline && (b.outline.length<3||b.outline.length>256||b.outline.some(p=>p.length!==2||!p.every(Number.isFinite))))throw new Error('Invalid collision outline');
    index(cells, Object.freeze({ ...b,outline:b.outline?.map(p=>Object.freeze([...p])) }));
  }
  for (const f of world.floors) {
    if (!Number.isFinite(f.elevation) || f.elevation < 0 || f.elevation > 10) throw new Error('Invalid floor');
    index(floors, Object.freeze({ ...f }));
  }
  if((world.triangles?.length??0)>200000)throw new Error('Too many terrain triangles');
  for(const vertices of world.triangles??[]) {
    if(vertices.length!==9||!vertices.every(Number.isFinite))throw new Error('Invalid terrain triangle');
    const minX=Math.min(vertices[0],vertices[3],vertices[6]),maxX=Math.max(vertices[0],vertices[3],vertices[6]);
    const minZ=Math.min(vertices[2],vertices[5],vertices[8]),maxZ=Math.max(vertices[2],vertices[5],vertices[8]);
    if(maxX-minX<1e-8||maxZ-minZ<1e-8)continue;
    index(triangles,{minX,maxX,minZ,maxZ,vertices:Object.freeze([...vertices])});
  }
  const bounds = { ...world.bounds }, baseHeight = world.baseHeight, slopeX = world.slopeX;
  const query = <T>(map: Map<string, T[]>, x: number, z: number) => map.get(`${Math.floor(x / CELL)}/${Math.floor(z / CELL)}`) ?? [];
  function ground(x: number, z: number) {
    let elevation = 0;
    for (const f of query(floors,x,z)) if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ) elevation = Math.max(elevation, f.elevation);
    let height=baseHeight+slopeX*x+elevation;
    for(const {vertices:p} of query(triangles,x,z)) {
      const denominator=(p[5]-p[8])*(p[0]-p[6])+(p[6]-p[3])*(p[2]-p[8]);
      if(Math.abs(denominator)<1e-10)continue;
      const a=((p[5]-p[8])*(x-p[6])+(p[6]-p[3])*(z-p[8]))/denominator;
      const b=((p[8]-p[2])*(x-p[6])+(p[0]-p[6])*(z-p[8]))/denominator;
      if(a>=-1e-7&&b>=-1e-7&&a+b<=1+1e-7)height=Math.max(height,a*p[1]+b*p[4]+(1-a-b)*p[7]);
    }
    return height;
  }
  const defaultSpawn={...world.spawn};
  return (startTick=0,spawn=defaultSpawn)=>{
  if(![spawn.x,spawn.z].every(Number.isFinite))throw new Error('Invalid character spawn');
  if(!Number.isSafeInteger(startTick)||startTick<0)throw new Error('Invalid character tick');
  let tick = startTick, x = spawn.x, z = spawn.z, y = ground(x,z), yaw = 0;
  let lastSequence = 0, acceptedTick = -1, expiry = startTick, dx = 0, dz = 0, run = false, facing:number|null = null;
  function support(px: number,pz: number) {
    let height=ground(px,pz);
    for(const b of obstacles(px,pz)) if(px>b.minX-RADIUS && px<b.maxX+RADIUS && pz>b.minZ-RADIUS && pz<b.maxZ+RADIUS && b.maxY<=y+.3 && touches(b,px,pz)) height=Math.max(height,b.maxY);
    return height;
  }
  let vehicleFrame:VehicleCharacterFrame|null=null;
  const obstacles=(px:number,pz:number)=>vehicleFrame?[...query(cells,px,pz),vehicleFrame.blocker]:query(cells,px,pz);
  let moving = false, grounded = true, verticalSpeed = 0, airborneTicks = 0, landedTick = -100, jump = false;
  function touches(b:CollisionBox,px:number,pz:number) {
    if(!b.outline)return true;
    let inside=false;
    for(let i=0,j=b.outline.length-1;i<b.outline.length;j=i++) {
      const a=b.outline[j],c=b.outline[i];
      if((a[1]>pz)!==(c[1]>pz)&&px<(c[0]-a[0])*(pz-a[1])/(c[1]-a[1])+a[0])inside=!inside;
      const dx=c[0]-a[0],dz=c[1]-a[1],t=Math.max(0,Math.min(1,((px-a[0])*dx+(pz-a[1])*dz)/(dx*dx+dz*dz||1)));
      if((px-a[0]-dx*t)**2+(pz-a[1]-dz*t)**2<RADIUS*RADIUS)return true;
    }
    return inside;
  }
  function blocked(px: number, pz: number, py: number) {
    if (px < bounds.minX + RADIUS || px > bounds.maxX - RADIUS || pz < bounds.minZ + RADIUS || pz > bounds.maxZ - RADIUS || py - y > 0.3) return true;
    return obstacles(px,pz).some(b => py < b.maxY && py + HEIGHT > b.minY && px > b.minX - RADIUS && px < b.maxX + RADIUS && pz > b.minZ - RADIUS && pz < b.maxZ + RADIUS && touches(b,px,pz));
  }
  if (blocked(x,z,y)) throw new Error('Character spawn is blocked');
  return {
    setVehicleFrame(frame:VehicleCharacterFrame|null){
      if(frame){
        if(frame.approach&&(![frame.approach.x,frame.approach.z,frame.approach.yaw].every(Number.isFinite)||!frame.approach.vehicleId.trim()))throw new Error('Invalid vehicle approach');
        if(![frame.blocker.minX,frame.blocker.maxX,frame.blocker.minZ,frame.blocker.maxZ,frame.blocker.minY,frame.blocker.maxY].every(Number.isFinite)||frame.blocker.minX>=frame.blocker.maxX||frame.blocker.minZ>=frame.blocker.maxZ||frame.blocker.minY>=frame.blocker.maxY)throw new Error('Invalid vehicle frame');
        for(const pose of [frame.pose,frame.release])if(pose&&![pose.x,pose.y,pose.z,pose.yaw].every(Number.isFinite))throw new Error('Invalid vehicle pose');
        const pose=frame.pose??frame.release;
        if(pose){x=pose.x;y=pose.y;z=pose.z;yaw=pose.yaw;verticalSpeed=0;grounded=true;jump=false;dx=dz=0;}
      }
      if(vehicleFrame?.approach&&!frame?.approach&&!frame?.pose){dx=dz=0;run=false;facing=null;expiry=tick;}
      vehicleFrame=frame;
    },
    receive(input: unknown, ownerId: string): Receipt {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('type' in input) || !('characterId' in input) || !('sequence' in input) || !('tick' in input) || !('x' in input) || !('z' in input) || !('run' in input) || !('jump' in input) || Object.keys(input).length !== ('facing' in input ? 9 : 8) || input.type !== 'move' || input.characterId !== 'local-player' || typeof input.sequence !== 'number' || !Number.isSafeInteger(input.sequence) || input.sequence <= 0 || typeof input.tick !== 'number' || !Number.isSafeInteger(input.tick) || input.tick < 0 || typeof input.x !== 'number' || typeof input.z !== 'number' || ![input.x,input.z].every(Number.isFinite) || Math.abs(input.x) > 1 || Math.abs(input.z) > 1 || typeof input.run !== 'boolean' || typeof input.jump !== 'boolean' || ('facing' in input && input.facing !== null && (typeof input.facing !== 'number' || !Number.isFinite(input.facing) || Math.abs(input.facing)>Math.PI))) return { accepted: false, reason: 'invalid' };
      if (vehicleFrame?.pose||vehicleFrame?.approach) return {accepted:false,reason:'vehicle'};
      if (ownerId !== 'local') return { accepted: false, reason: 'owner' };
      if (input.sequence <= lastSequence) return { accepted: false, reason: 'sequence' };
      if (input.tick > tick || tick-input.tick > 30) return { accepted: false, reason: 'stale' };
      if (acceptedTick === tick) return { accepted: false, reason: 'rate' };
      lastSequence = input.sequence; acceptedTick = tick; expiry = tick + 12;
      const length = Math.max(1, Math.hypot(input.x,input.z));
      dx = input.x / length; dz = input.z / length; run = input.run; jump = input.jump && grounded; facing='facing' in input && typeof input.facing==='number'?input.facing:null;
      return { accepted: true, reason: 'accepted' };
    },
    step(nextTick: number) {
      if (nextTick !== tick + 1) throw new Error('Character ticks must be consecutive');
      tick = nextTick;
      moving = false;
      if(vehicleFrame?.pose)return;
      if(vehicleFrame?.approach){const a=vehicleFrame.approach,tx=a.x-x,tz=a.z-z,length=Math.hypot(tx,tz);const scale=Math.min(1,length*60/(a.run?7:1.8));dx=length>.01?tx/length*scale:0;dz=length>.01?tz/length*scale:0;run=a.run;facing=a.align?a.yaw:null;jump=false;expiry=tick+1;}
      if (jump && grounded) { verticalSpeed = 5.5; grounded = false; airborneTicks = 0; }
      jump = false;
      const speed = run ? 7 : 1.8;
      if (tick <= expiry) {
        // Swept movement is subdivided below the radius, then slides along each axis.
        const steps = Math.max(1, Math.ceil(speed / 60 / 0.1));
        const beforeX = x, beforeZ = z;
        for (let i = 0; i < steps; i++) {
          const nx = x + dx * speed / 60 / steps;
          if (!blocked(nx,z,grounded ? support(nx,z) : Math.max(y,ground(nx,z)))) x = nx;
          const nz = z + dz * speed / 60 / steps;
          if (!blocked(x,nz,grounded ? support(x,nz) : Math.max(y,ground(x,nz)))) z = nz;
          if (grounded) { const floor=support(x,z); if(y-floor>.3) grounded=false; else y=floor; }
        }
        moving = Math.hypot(x-beforeX,z-beforeZ) > 1e-8;
        if (facing!==null) yaw=facing;
        else if (moving) yaw = Math.atan2(dx,dz);
      }
      if (!grounded) {
        airborneTicks++;
        verticalSpeed -= 16 / 60;
        let nextY = y + verticalSpeed / 60;
        let support = ground(x,z);
        for (const b of query(cells,x,z)) {
          if (x <= b.minX-RADIUS || x >= b.maxX+RADIUS || z <= b.minZ-RADIUS || z >= b.maxZ+RADIUS || !touches(b,x,z)) continue;
          if (verticalSpeed <= 0 && y >= b.maxY-1e-8) support = Math.max(support,b.maxY);
          if (verticalSpeed > 0 && y+HEIGHT <= b.minY && nextY+HEIGHT >= b.minY) { nextY=b.minY-HEIGHT;verticalSpeed=0; }
        }
        if (nextY <= support) { nextY=support;verticalSpeed=0;grounded=true;landedTick=tick; }
        y=nextY;
      }
    },
    snapshot(): CharacterSnapshot { return Object.freeze({ tick, id: 'local-player', ownerId: 'local', x,y,z,yaw,grounded,verticalSpeed,airborneTicks,landedTick,moving,running: moving && run,lastSequence,...(vehicleFrame?.approach?{vehicleId:vehicleFrame.approach.vehicleId,vehicleAnimation:'approaching' as const}:{}),...(vehicleFrame?.pose?{vehicleId:vehicleFrame.pose.vehicleId,vehicleAnimation:vehicleFrame.pose.animation,...(vehicleFrame.pose.rotation?{vehicleRotation:[...vehicleFrame.pose.rotation]}:{})}:{}) }); },
  };
  };
}

export interface DeliveryOptions { readonly latencyTicks?: number; readonly jitterTicks?: number; readonly dropEvery?: number; readonly seed?: number }
export function createLocalConnection(authority: ReturnType<typeof createCharacterAuthority>, options: DeliveryOptions = {}) {
  const latency = options.latencyTicks ?? 0, jitter = options.jitterTicks ?? 0, dropEvery = options.dropEvery ?? 0;
  let seed = options.seed ?? 2026;
  if (![latency,jitter,dropEvery,seed].every(Number.isSafeInteger) || latency < 0 || latency > 120 || jitter < 0 || jitter > 120 || dropEvery < 0 || seed < 0 || seed > 0xffffffff) throw new Error('Invalid delivery configuration');
  const queue: { due: number; command: MoveCommand; resolve(value: Receipt): void }[] = [];
  let count = 0, stopped = false;
  return {
    send(command: MoveCommand): Promise<Receipt> {
      if (stopped) return Promise.resolve({ accepted: false, reason: 'closed' });
      if (queue.length >= 64) return Promise.resolve({ accepted: false, reason: 'queue' });
      count++;
      if (dropEvery && count % dropEvery === 0) return Promise.resolve({ accepted: false, reason: 'dropped' });
      seed = (Math.imul(seed,1664525) + 1013904223) >>> 0;
      const delay = Math.max(0, latency + Math.floor(seed / 0x100000000 * (jitter * 2 + 1)) - jitter);
      return new Promise(resolve => queue.push({ command: { ...command }, due: authority.snapshot().tick + delay + 1, resolve }));
    },
    step(tick: number) {
      queue.sort((a,b) => a.due - b.due);
      while (queue.length && queue[0].due <= tick) {
        const delivery = queue.shift();
        if (delivery) delivery.resolve(authority.receive(delivery.command,'local'));
      }
      authority.step(tick);
    },
    snapshot: authority.snapshot,
    close() { stopped = true; for (const item of queue.splice(0)) item.resolve({ accepted: false, reason: 'closed' }); },
  };
}
