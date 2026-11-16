import type { CollisionWorld, CollisionBox } from '../world/headless.ts';

export interface MoveCommand { readonly type: 'move'; readonly characterId: string; readonly sequence: number; readonly tick: number; readonly x: number; readonly z: number; readonly run: boolean; readonly jump: boolean }
export interface CharacterSnapshot {
  readonly tick: number; readonly id: string; readonly ownerId: string;
  readonly x: number; readonly y: number; readonly z: number; readonly yaw: number;
  readonly grounded: boolean; readonly verticalSpeed: number; readonly airborneTicks: number; readonly landedTick: number;
  readonly moving: boolean; readonly running: boolean; readonly lastSequence: number;
}
export interface Receipt { readonly accepted: boolean; readonly reason: string }
const RADIUS = 0.35;
const HEIGHT = 1.8;
const CELL = 32;

export function createCharacterAuthority(world: CollisionWorld, startTick = 0) {
  if (!Number.isSafeInteger(startTick) || startTick < 0 || ![world.baseHeight, world.slopeX, world.spawn.x, world.spawn.z, world.baseHeight+world.slopeX*world.bounds.minX, world.baseHeight+world.slopeX*world.bounds.maxX, ...Object.values(world.bounds)].every(Number.isFinite) || Math.abs(world.slopeX) > 0.1 || world.bounds.minX >= world.bounds.maxX || world.bounds.minZ >= world.bounds.maxZ || world.blockers.length > 10000 || world.floors.length > 10000) throw new Error('Invalid character world');
  const cells = new Map<string, CollisionBox[]>();
  const floors = new Map<string, (CollisionWorld['floors'][number])[]>();
  let entries = 0;
  function index<T extends { minX: number; maxX: number; minZ: number; maxZ: number }>(map: Map<string, T[]>, item: T) {
    if (![item.minX, item.maxX, item.minZ, item.maxZ].every(Number.isFinite) || item.minX >= item.maxX || item.minZ >= item.maxZ) throw new Error('Invalid collision bounds');
    const minX = Math.floor((item.minX - RADIUS) / CELL), maxX = Math.floor((item.maxX + RADIUS) / CELL);
    const minZ = Math.floor((item.minZ - RADIUS) / CELL), maxZ = Math.floor((item.maxZ + RADIUS) / CELL);
    entries += (maxX - minX + 1) * (maxZ - minZ + 1);
    if (entries > 200000 || (maxX - minX + 1) * (maxZ - minZ + 1) > 4096 || ![minX,maxX,minZ,maxZ].every(Number.isSafeInteger)) throw new Error('Collision grid budget exceeded');
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const key = `${x}/${z}`; const list = map.get(key);
      if (list) list.push(item); else map.set(key, [item]);
    }
  }
  for (const b of world.blockers) {
    if (![b.minY,b.maxY].every(Number.isFinite) || b.maxY <= b.minY) throw new Error('Invalid collision height');
    index(cells, Object.freeze({ ...b }));
  }
  for (const f of world.floors) {
    if (!Number.isFinite(f.elevation) || f.elevation < 0 || f.elevation > 10) throw new Error('Invalid floor');
    index(floors, Object.freeze({ ...f }));
  }
  const bounds = { ...world.bounds }, baseHeight = world.baseHeight, slopeX = world.slopeX;
  const query = <T>(map: Map<string, T[]>, x: number, z: number) => map.get(`${Math.floor(x / CELL)}/${Math.floor(z / CELL)}`) ?? [];
  function ground(x: number, z: number) {
    let elevation = 0;
    for (const f of query(floors,x,z)) if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ) elevation = Math.max(elevation, f.elevation);
    return baseHeight + slopeX * x + elevation;
  }
  let tick = startTick, x = world.spawn.x, z = world.spawn.z, y = ground(x,z), yaw = 0;
  let lastSequence = 0, acceptedTick = -1, expiry = startTick, dx = 0, dz = 0, run = false;
  function support(px: number,pz: number) {
    let height=ground(px,pz);
    for(const b of query(cells,px,pz)) if(px>b.minX-RADIUS && px<b.maxX+RADIUS && pz>b.minZ-RADIUS && pz<b.maxZ+RADIUS && b.maxY<=y+.3) height=Math.max(height,b.maxY);
    return height;
  }
  let moving = false, grounded = true, verticalSpeed = 0, airborneTicks = 0, landedTick = -100, jump = false;
  function blocked(px: number, pz: number, py: number) {
    if (px < bounds.minX + RADIUS || px > bounds.maxX - RADIUS || pz < bounds.minZ + RADIUS || pz > bounds.maxZ - RADIUS || py - y > 0.3) return true;
    return query(cells,px,pz).some(b => py < b.maxY && py + HEIGHT > b.minY && px > b.minX - RADIUS && px < b.maxX + RADIUS && pz > b.minZ - RADIUS && pz < b.maxZ + RADIUS);
  }
  if (blocked(x,z,y)) throw new Error('Character spawn is blocked');
  return {
    receive(input: unknown, ownerId: string): Receipt {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('type' in input) || !('characterId' in input) || !('sequence' in input) || !('tick' in input) || !('x' in input) || !('z' in input) || !('run' in input) || !('jump' in input) || Object.keys(input).length !== 8 || input.type !== 'move' || input.characterId !== 'local-player' || typeof input.sequence !== 'number' || !Number.isSafeInteger(input.sequence) || input.sequence <= 0 || typeof input.tick !== 'number' || !Number.isSafeInteger(input.tick) || input.tick < 0 || typeof input.x !== 'number' || typeof input.z !== 'number' || ![input.x,input.z].every(Number.isFinite) || Math.abs(input.x) > 1 || Math.abs(input.z) > 1 || typeof input.run !== 'boolean' || typeof input.jump !== 'boolean') return { accepted: false, reason: 'invalid' };
      if (ownerId !== 'local') return { accepted: false, reason: 'owner' };
      if (input.sequence <= lastSequence) return { accepted: false, reason: 'sequence' };
      if (input.tick > tick || tick-input.tick > 30) return { accepted: false, reason: 'stale' };
      if (acceptedTick === tick) return { accepted: false, reason: 'rate' };
      lastSequence = input.sequence; acceptedTick = tick; expiry = tick + 12;
      const length = Math.max(1, Math.hypot(input.x,input.z));
      dx = input.x / length; dz = input.z / length; run = input.run; jump = input.jump && grounded;
      return { accepted: true, reason: 'accepted' };
    },
    step(nextTick: number) {
      if (nextTick !== tick + 1) throw new Error('Character ticks must be consecutive');
      tick = nextTick;
      moving = false;
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
        if (moving) yaw = Math.atan2(dx,dz);
      }
      if (!grounded) {
        airborneTicks++;
        verticalSpeed -= 16 / 60;
        let nextY = y + verticalSpeed / 60;
        let support = ground(x,z);
        for (const b of query(cells,x,z)) {
          if (x <= b.minX-RADIUS || x >= b.maxX+RADIUS || z <= b.minZ-RADIUS || z >= b.maxZ+RADIUS) continue;
          if (verticalSpeed <= 0 && y >= b.maxY-1e-8) support = Math.max(support,b.maxY);
          if (verticalSpeed > 0 && y+HEIGHT <= b.minY && nextY+HEIGHT >= b.minY) { nextY=b.minY-HEIGHT;verticalSpeed=0; }
        }
        if (nextY <= support) { nextY=support;verticalSpeed=0;grounded=true;landedTick=tick; }
        y=nextY;
      }
    },
    snapshot(): CharacterSnapshot { return Object.freeze({ tick, id: 'local-player', ownerId: 'local', x,y,z,yaw,grounded,verticalSpeed,airborneTicks,landedTick,moving,running: moving && run,lastSequence }); },
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
