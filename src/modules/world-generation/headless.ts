export interface Rectangle { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number }
export interface Street {
  readonly id: string;
  readonly axis: 'x' | 'z';
  readonly coordinate: number;
  readonly width: number;
  readonly sidewalk: number;
}
// shortcut: straight full-span streets on one height plane, extend when a chosen map needs curves or terrain.
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
    ? { ...bounds, minZ: street.coordinate - half, maxZ: street.coordinate + half }
    : { ...bounds, minX: street.coordinate - half, maxX: street.coordinate + half };
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
    ids.add(street.id);
    const area = ribbon(street, bounds, street.sidewalk);
    if (area.minX < bounds.minX || area.maxX > bounds.maxX || area.minZ < bounds.minZ || area.maxZ > bounds.maxZ) throw new Error('Улица выходит за границы участка');
    const length = street.axis === 'x' ? bounds.maxX - bounds.minX : bounds.maxZ - bounds.minZ;
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
    const start = street.axis === 'x' ? bounds.minX : bounds.minZ;
    const end = street.axis === 'x' ? bounds.maxX : bounds.maxZ;
    const count = Math.ceil((end - start) / scheme.lampSpacing);
    for (let i = 0; i < count; i++) {
      const along = start + (i + 0.5) * scheme.lampSpacing;
      if (along + 0.4 > end) continue;
      if (scheme.streets.some(other => other.axis !== street.axis && Math.abs(along - other.coordinate) < other.width / 2 + other.sidewalk + 0.6)) continue;
      for (const side of [-1, 1]) {
        const across = street.coordinate + side * (street.width / 2 + street.sidewalk - 0.45);
        const x = street.axis === 'x' ? along : across;
        const z = street.axis === 'x' ? across : along;
        if (scheme.reserved.some(zone => overlaps(zone, { minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.4, maxZ: z + 0.4 }))) continue;
        add({ key: `${scheme.id}/lamp/${street.id}/${i}/${side}`, templateId: 'world/lamp', parameters: {},
          position: [x, height(x) + SIDEWALK_HEIGHT, z], rotation: [0, street.axis === 'x' ? side * Math.PI / 2 : side > 0 ? Math.PI : 0, 0] });
      }
    }
  }
  return { version: 1, schemeId: scheme.id, seed: scheme.seed, randomState, bounds: { ...bounds }, objects };
}
