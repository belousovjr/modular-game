export interface Rectangle { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number }
export interface Street {
  readonly id: string;
  readonly axis: 'x' | 'z';
  readonly coordinate: number;
  readonly width: number;
  readonly sidewalk: number;
  readonly start?: number;
  readonly end?: number;
}
// shortcut: axis-aligned street segments on one height plane; extend for diagonal streets or terrain.
export interface WorldScheme {
  readonly id: string;
  readonly seed: number;
  readonly bounds: Rectangle;
  readonly baseHeight: number;
  readonly slopeX: number;
  readonly streets: readonly Street[];
  readonly lampSpacing: number;
  readonly reserved: readonly Rectangle[];
}
export interface WorldPlacement {
  readonly key: string;
  readonly templateId: string;
  readonly parameters: Readonly<Record<string, number>>;
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
}
export interface GeneratedWorld {
  readonly version: 1;
  readonly schemeId: string;
  readonly seed: number;
  readonly randomState: number;
  readonly bounds: Rectangle;
  readonly objects: readonly WorldPlacement[];
}

const CURB_WIDTH = 0.15;
const SIDEWALK_HEIGHT = 0.18;
const MAX_OBJECTS = 10_000;
function validRectangle(rect: Rectangle) {
  return [rect.minX, rect.maxX, rect.minZ, rect.maxZ].every(Number.isFinite) && rect.maxX > rect.minX && rect.maxZ > rect.minZ;
}
function overlaps(a: Rectangle, b: Rectangle) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}
function ribbon(street: Street, bounds: Rectangle, margin: number): Rectangle {
  const half = street.width / 2 + margin;
  return street.axis === 'x'
    ? { minX: street.start ?? bounds.minX, maxX: street.end ?? bounds.maxX, minZ: street.coordinate - half, maxZ: street.coordinate + half }
    : { minZ: street.start ?? bounds.minZ, maxZ: street.end ?? bounds.maxZ, minX: street.coordinate - half, maxX: street.coordinate + half };
}
function contains(rect: Rectangle, x: number, z: number) {
  return x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ;
}
function validate(scheme: WorldScheme) {
  const bounds = scheme.bounds;
  if (!scheme.id.trim() || !validRectangle(bounds) || ![scheme.baseHeight, scheme.slopeX, scheme.lampSpacing].every(Number.isFinite) ||
      Math.abs(scheme.slopeX) > 0.1 || scheme.lampSpacing < 2 || !Number.isInteger(scheme.seed) || scheme.seed < 0 || scheme.seed > 0xffffffff ||
      !scheme.streets.length || scheme.streets.length > 32 || scheme.reserved.length > 32) throw new Error('Некорректная схема мира');
  const ids = new Set<string>();
  let lampCandidates = 0;
  for (const street of scheme.streets) {
    if (!street.id.trim() || ids.has(street.id) || !['x', 'z'].includes(street.axis) ||
        ![street.coordinate, street.width, street.sidewalk].every(Number.isFinite) || street.width < 2 || street.sidewalk < 1) throw new Error('Некорректная улица');
    if ([street.start, street.end].some(value => value !== undefined && !Number.isFinite(value))) throw new Error('Некорректная длина улицы');
    ids.add(street.id);
    const area = ribbon(street, bounds, street.sidewalk);
    if (!validRectangle(area) || area.minX < bounds.minX || area.maxX > bounds.maxX || area.minZ < bounds.minZ || area.maxZ > bounds.maxZ) throw new Error('Улица выходит за границы участка');
    const length = street.axis === 'x' ? area.maxX - area.minX : area.maxZ - area.minZ;
    lampCandidates += 2 * Math.ceil(length / scheme.lampSpacing);
  }
  if (lampCandidates > MAX_OBJECTS) throw new Error('Превышен бюджет генерации фонарей');
  for (let i = 0; i < scheme.streets.length; i++) {
    for (const other of scheme.streets.slice(i + 1)) {
      const street = scheme.streets[i];
      if (street.axis === other.axis && overlaps(ribbon(street, bounds, street.sidewalk), ribbon(other, bounds, other.sidewalk))) throw new Error('Параллельные улицы перекрываются');
    }
  }
  for (const zone of scheme.reserved) {
    if (!validRectangle(zone) || zone.minX < bounds.minX || zone.maxX > bounds.maxX || zone.minZ < bounds.minZ || zone.maxZ > bounds.maxZ) throw new Error('Некорректная авторская зона');
    if (scheme.streets.some(street => overlaps(zone, ribbon(street, bounds, 0)))) throw new Error('Авторская зона перекрывает проезжую часть');
  }
}

export function generateWorld(scheme: WorldScheme): GeneratedWorld {
  validate(scheme);
  const { bounds } = scheme;
  let randomState = scheme.seed;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x100000000; };
  const objects: WorldPlacement[] = [];
  const height = (x: number) => scheme.baseHeight + scheme.slopeX * x;
  const angle = Math.atan(scheme.slopeX);
  const add = (object: WorldPlacement) => {
    if (objects.length >= MAX_OBJECTS) throw new Error('Превышен бюджет объектов участка');
    if (![...object.position, ...object.rotation, ...Object.values(object.parameters)].every(Number.isFinite)) throw new Error('Неконечные размеры или координаты результата');
    objects.push(object);
  };
  const slab = (key: string, kind: string, rect: Rectangle, elevation: number, thickness: number) => {
    const x = (rect.minX + rect.maxX) / 2;
    const z = (rect.minZ + rect.maxZ) / 2;
    add({ key: `${scheme.id}/${key}`, templateId: `world/${kind}`,
      parameters: { width: (rect.maxX - rect.minX) / Math.cos(angle), depth: rect.maxZ - rect.minZ, thickness },
      position: [x, height(x) + elevation, z], rotation: [0, 0, angle] });
  };
  slab('terrain', 'terrain', bounds, -0.05, 0.6);
  const xs = new Set([bounds.minX, bounds.maxX]);
  const zs = new Set([bounds.minZ, bounds.maxZ]);
  for (const street of scheme.streets) {
    const cuts = street.axis === 'x' ? zs : xs;
    const along = street.axis === 'x' ? xs : zs;
    if (street.start !== undefined) along.add(street.start);
    if (street.end !== undefined) along.add(street.end);
    for (const margin of [0, CURB_WIDTH, street.sidewalk]) {
      cuts.add(street.coordinate - street.width / 2 - margin);
      cuts.add(street.coordinate + street.width / 2 + margin);
    }
  }
  for (const zone of scheme.reserved) { xs.add(zone.minX); xs.add(zone.maxX); zs.add(zone.minZ); zs.add(zone.maxZ); }
  const xCuts = [...xs].sort((a, b) => a - b);
  const zCuts = [...zs].sort((a, b) => a - b);
  if ((xCuts.length - 1) * (zCuts.length - 1) > MAX_OBJECTS) throw new Error('Превышен бюджет разбиения участка');
  for (let ix = 0; ix + 1 < xCuts.length; ix++) {
    for (let iz = 0; iz + 1 < zCuts.length; iz++) {
      const rect = { minX: xCuts[ix], maxX: xCuts[ix + 1], minZ: zCuts[iz], maxZ: zCuts[iz + 1] };
      const x = (rect.minX + rect.maxX) / 2;
      const z = (rect.minZ + rect.maxZ) / 2;
      if (scheme.reserved.some(zone => contains(zone, x, z))) continue;
      if (scheme.streets.some(street => contains(ribbon(street, bounds, 0), x, z))) slab(`road/${ix}/${iz}`, 'road', rect, 0, 0.3);
      else if (scheme.streets.some(street => contains(ribbon(street, bounds, street.sidewalk), x, z))) {
        const curb = scheme.streets.some(street => contains(ribbon(street, bounds, CURB_WIDTH), x, z));
        slab(`walk/${ix}/${iz}`, curb ? 'curb' : 'sidewalk', rect, curb ? 0.2 : SIDEWALK_HEIGHT, 0.4);
      } else if (rect.maxX - rect.minX > 7 && rect.maxZ - rect.minZ > 7) {
        const columns = Math.ceil((rect.maxX - rect.minX) / 32);
        const rows = Math.ceil((rect.maxZ - rect.minZ) / 32);
        if (objects.length + columns * rows > MAX_OBJECTS) throw new Error('Превышен бюджет застройки участка');
        const lotWidth = (rect.maxX - rect.minX) / columns;
        const lotDepth = (rect.maxZ - rect.minZ) / rows;
        const width = lotWidth - 3;
        const depth = lotDepth - 3;
        for (let column = 0; column < columns; column++) {
          for (let row = 0; row < rows; row++) {
            const buildingX = rect.minX + (column + 0.5) * lotWidth;
            const buildingZ = rect.minZ + (row + 0.5) * lotDepth;
            add({ key: `${scheme.id}/building/${ix}/${iz}/${column}/${row}`, templateId: 'world/building',
              parameters: { width, depth, height: 8 + Math.floor(random() * 20), foundation: Math.abs(scheme.slopeX) * width + 0.4 },
              position: [buildingX, height(buildingX) + Math.abs(scheme.slopeX) * width / 2, buildingZ], rotation: [0, 0, 0] });
          }
        }
      }
    }
  }
  for (const street of scheme.streets) {
    const start = street.start ?? (street.axis === 'x' ? bounds.minX : bounds.minZ);
    const end = street.end ?? (street.axis === 'x' ? bounds.maxX : bounds.maxZ);
    const count = Math.ceil((end - start) / scheme.lampSpacing);
    for (let i = 0; i < count; i++) {
      const along = start + (i + 0.5) * scheme.lampSpacing;
      if (along + 0.4 > end) continue;
      for (const side of [-1, 1]) {
        const across = street.coordinate + side * (street.width / 2 + street.sidewalk - 0.45);
        const x = street.axis === 'x' ? along : across;
        const z = street.axis === 'x' ? across : along;
        if (scheme.streets.some(other => other !== street && contains(ribbon(other, bounds, other.sidewalk + 0.6), x, z))) continue;
        if (scheme.reserved.some(zone => overlaps(zone, { minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.4, maxZ: z + 0.4 }))) continue;
        add({ key: `${scheme.id}/lamp/${street.id}/${i}/${side}`, templateId: 'world/lamp', parameters: {},
          position: [x, height(x) + SIDEWALK_HEIGHT, z], rotation: [0, street.axis === 'x' ? side * Math.PI / 2 : side > 0 ? Math.PI : 0, 0] });
      }
    }
  }
  return { version: 1, schemeId: scheme.id, seed: scheme.seed, randomState, bounds: { ...bounds }, objects };
}


export interface WorldRegion { readonly id: string; readonly bounds: Rectangle }

export function generateWorldRegions(scheme: WorldScheme, regions: readonly WorldRegion[]): readonly GeneratedWorld[] {
  validate(scheme);
  if (!regions.length || regions.length > 16) throw new Error('Нужно от 1 до 16 участков');
  const ids = new Set<string>();
  let area = 0;
  for (let i = 0; i < regions.length; i++) {
    const { id, bounds: b } = regions[i];
    if (!id.trim() || ids.has(id) || !validRectangle(b) || b.minX < scheme.bounds.minX || b.maxX > scheme.bounds.maxX ||
        b.minZ < scheme.bounds.minZ || b.maxZ > scheme.bounds.maxZ || regions.slice(0, i).some(r => overlaps(r.bounds, b))) throw new Error('Некорректные границы участков');
    ids.add(id); area += (b.maxX - b.minX) * (b.maxZ - b.minZ);
  }
  const totalArea = (scheme.bounds.maxX - scheme.bounds.minX) * (scheme.bounds.maxZ - scheme.bounds.minZ);
  if (!Number.isFinite(area) || Math.abs(area - totalArea) > totalArea * 1e-12) throw new Error('Участки должны покрывать всю схему');
  const generated = generateWorld(scheme);
  const angle = Math.atan(scheme.slopeX);
  let objectCount = 0;
  return regions.map(region => {
    const objects: WorldPlacement[] = [];
    for (const object of generated.objects) {
      const [x, , z] = object.position;
      const b = region.bounds;
      if (!['world/terrain', 'world/road', 'world/sidewalk', 'world/curb'].includes(object.templateId)) {
        // Half-open ownership assigns boundary objects exactly once; full bounds still drive streaming.
        if (x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ) objects.push(object);
        continue;
      }
      const halfX = object.parameters.width * Math.cos(angle) / 2;
      const halfZ = object.parameters.depth / 2;
      const minX = Math.max(b.minX, x - halfX), maxX = Math.min(b.maxX, x + halfX);
      const minZ = Math.max(b.minZ, z - halfZ), maxZ = Math.min(b.maxZ, z + halfZ);
      if (maxX - minX < 1e-9 || maxZ - minZ < 1e-9) continue;
      const centerX = (minX + maxX) / 2;
      objects.push({ ...object, key: `${object.key}@${region.id}`,
        parameters: { ...object.parameters, width: (maxX - minX) / Math.cos(angle), depth: maxZ - minZ },
        position: [centerX, object.position[1] + (centerX - x) * scheme.slopeX, (minZ + maxZ) / 2] });
    }
    objectCount += objects.length;
    if (objectCount > MAX_OBJECTS) throw new Error('Превышен бюджет объектов участков');
    return { ...generated, schemeId: region.id, bounds: { ...region.bounds }, objects };
  });
}

export interface CityMesh { readonly surface: string; readonly positions: readonly number[]; readonly indices: readonly number[]; readonly uvs?: readonly number[] }
export interface CitySource {
  readonly version: number; readonly id: string; readonly bounds: Rectangle;
  readonly spawn: {readonly x:number;readonly z:number}; readonly waterLevel:number;
  readonly chunks: readonly {readonly id:string;readonly bounds:Rectangle;readonly meshes:readonly CityMesh[];readonly buildingIds:readonly string[];readonly details?:readonly {readonly id:string;readonly bounds:Rectangle;readonly meshes:readonly CityMesh[]}[]}[];
  readonly placements: readonly WorldPlacement[];
  readonly colliders: readonly (Rectangle & {readonly id:string;readonly minY:number;readonly maxY:number;readonly outline:readonly (readonly number[])[];readonly parts?:readonly (readonly (readonly number[])[])[]})[];
  readonly trafficLayout?: {readonly crosswalks: readonly {readonly center:readonly number[];readonly direction:readonly number[];readonly outline:readonly (readonly number[])[]}[]};
  readonly roads: readonly {readonly id:string;readonly name:string;readonly points:readonly (readonly number[])[];readonly width:number;readonly oneway:string;readonly bridge:boolean;readonly layer:number}[];
}

// Polygon boolean operations and triangulation run offline; runtime validates the pinned result.
export function generateCity(source: CitySource): CitySource {
  if(source.version!==1 || !source.id.trim() || !validRectangle(source.bounds) || ![source.spawn.x,source.spawn.z,source.waterLevel].every(Number.isFinite) || source.chunks.length>2048 || source.placements.length>20000 || source.roads.length>20000 || source.colliders.length>10000) throw new Error('Invalid city source');
  const ids=new Set<string>();let vertices=0,detailCount=0;
  for(const base of source.chunks) {
    detailCount+=base.details?.length??0;
    if(detailCount>3072||(base.details?.length??0)>1024)throw new Error('Invalid city details');
    for(const chunk of [base,...base.details??[]]) {
    if(ids.has(chunk.id)||!chunk.id.trim()||!validRectangle(chunk.bounds)||chunk.meshes.length>32)throw new Error('Invalid city chunk');ids.add(chunk.id);
    for(const mesh of chunk.meshes) {
      vertices+=mesh.positions.length/3;
      if(vertices>2000000||!mesh.surface.trim()||!mesh.positions.length||mesh.positions.length%3||mesh.indices.length%3||!mesh.positions.every(Number.isFinite)||!mesh.indices.every(i=>Number.isSafeInteger(i)&&i>=0&&i<mesh.positions.length/3))throw new Error('Invalid city triangles');
      if(mesh.uvs&&(mesh.uvs.length!==mesh.positions.length/3*2||!mesh.uvs.every(Number.isFinite)))throw new Error('Invalid city UVs');
    }
  }
  }
  for(const p of source.placements) {
    if(ids.has(p.key)||!p.key.trim()||(!p.templateId.startsWith('city/')&&p.templateId!=='world/lamp')||p.position.length!==3||p.rotation.length!==3||![...p.position,...p.rotation,...Object.values(p.parameters)].every(Number.isFinite))throw new Error('Invalid city placement');ids.add(p.key);
  }
  const validRing=(ring:readonly (readonly number[])[])=>ring.length>=3&&ring.length<=256&&ring.every(p=>p.length===2&&p.every(Number.isFinite));
  const crosswalks=source.trafficLayout?.crosswalks;
  if (source.trafficLayout && (!Array.isArray(crosswalks) || crosswalks.length>20000 ||
      crosswalks.some(crossing=>!Array.isArray(crossing.center)||crossing.center.length!==2||
        !crossing.center.every(Number.isFinite)||!Array.isArray(crossing.direction)||crossing.direction.length!==2||
        !crossing.direction.every(Number.isFinite)||Math.abs(Math.hypot(...crossing.direction)-1)>.01||
        !Array.isArray(crossing.outline)||!validRing(crossing.outline)))) throw new Error('Invalid city crosswalks');
  let courtyardParts=0;
  for(const c of source.colliders){
    if(!validRectangle(c)||![c.minY,c.maxY].every(Number.isFinite)||c.maxY<=c.minY||!validRing(c.outline))throw new Error('Invalid city collider');
    if(c.parts){
      courtyardParts+=c.parts.length;
      if(!c.parts.length||c.parts.length>128||courtyardParts>2048||c.parts.some(ring=>!validRing(ring)))throw new Error('Invalid city collider parts');
    }
  }
  return source;
}
