import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, type WorldScheme, type WorldPlacement, type Rectangle } from '../src/modules/world-generation/headless.ts';

const scheme: WorldScheme = {
  id: 'test-district', seed: 12345, bounds: { minX: -20, maxX: 20, minZ: -20, maxZ: 20 },
  baseHeight: 1, slopeX: 0.03, lampSpacing: 8, reserved: [],
  streets: [
    { id: 'horizontal', axis: 'x', coordinate: 0, width: 6, sidewalk: 2 },
    { id: 'vertical', axis: 'z', coordinate: 0, width: 6, sidewalk: 2 },
  ],
};
function footprint(object: WorldPlacement): Rectangle {
  const halfX = object.parameters.width * Math.cos(object.rotation[2]) / 2;
  const halfZ = object.parameters.depth / 2;
  return { minX: object.position[0] - halfX, maxX: object.position[0] + halfX, minZ: object.position[2] - halfZ, maxZ: object.position[2] + halfZ };
}
function overlap(a: Rectangle, b: Rectangle) {
  return a.minX < b.maxX - 1e-9 && a.maxX > b.minX + 1e-9 && a.minZ < b.maxZ - 1e-9 && a.maxZ > b.minZ + 1e-9;
}

test('world generation is seeded, serializable and uses stable content keys without mutating its input', () => {
  const before = JSON.stringify(scheme);
  const a = generateWorld(scheme);
  assert.deepEqual(a, generateWorld(scheme));
  assert.equal(JSON.stringify(scheme), before);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.equal(new Set(a.objects.map(object => object.key)).size, a.objects.length);
  assert.notEqual(a.randomState, a.seed);
  const b = generateWorld({ ...scheme, seed: 7 });
  assert.notDeepEqual(a.objects.filter(object => object.templateId === 'world/building'), b.objects.filter(object => object.templateId === 'world/building'));
  assert.deepEqual(a.objects.map(object => object.key), b.objects.map(object => object.key));
});

test('crossings are tiled once and adjacent road, curb and sidewalk surfaces share the height plane', () => {
  for (const slopeX of [-0.05, 0, 0.05]) {
    const result = generateWorld({ ...scheme, slopeX });
    const surfaces = result.objects.filter(object => ['world/road', 'world/sidewalk', 'world/curb'].includes(object.templateId));
    let roadArea = 0;
    for (let i = 0; i < surfaces.length; i++) {
      const object = surfaces[i];
      const rect = footprint(object);
      for (const other of surfaces.slice(i + 1)) assert.equal(overlap(rect, footprint(other)), false);
      if (object.templateId === 'world/road') roadArea += (rect.maxX - rect.minX) * (rect.maxZ - rect.minZ);
      const elevation = object.templateId === 'world/road' ? 0 : object.templateId === 'world/curb' ? 0.2 : 0.18;
      for (const side of [-1, 1]) {
        const localX = side * object.parameters.width / 2;
        const worldX = object.position[0] + localX * Math.cos(object.rotation[2]);
        const worldY = object.position[1] + localX * Math.sin(object.rotation[2]);
        assert.ok(Math.abs(worldY - (scheme.baseHeight + slopeX * worldX + elevation)) < 1e-9);
      }
    }
    assert.ok(Math.abs(roadArea - (6 * 40 * 2 - 6 * 6)) < 1e-9);
    for (const lamp of result.objects.filter(object => object.templateId === 'world/lamp')) {
      const [x, y, z] = lamp.position;
      assert.ok(Math.abs(y - (scheme.baseHeight + slopeX * x + 0.18)) < 1e-9);
      assert.equal(Math.abs(x) < 5.6 && Math.abs(z) < 5.6, false);
    }
  }
});

test('author zones exclude generated surfaces, buildings and lamps while retaining underlying ground', () => {
  const zone = { minX: 3.5, maxX: 16, minZ: 8, maxZ: 16 };
  const result = generateWorld({ ...scheme, reserved: [zone] });
  assert.ok(result.objects.some(object => object.templateId === 'world/terrain'));
  for (const object of result.objects) {
    if (object.templateId === 'world/terrain') continue;
    const rect = object.templateId === 'world/lamp'
      ? { minX: object.position[0] - 0.4, maxX: object.position[0] + 0.4, minZ: object.position[2] - 0.4, maxZ: object.position[2] + 0.4 }
      : footprint(object);
    assert.equal(overlap(zone, rect), false, object.key);
  }
});

test('large blocks get multiple larger buildings with setbacks and a bounded generation cost', () => {
  const result = generateWorld({ ...scheme, bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 } });
  const buildings = result.objects.filter(object => object.templateId === 'world/building');
  assert.equal(buildings.length, 36);
  let area = 0;
  for (let i = 0; i < buildings.length; i++) {
    const building = buildings[i];
    assert.ok(building.parameters.width > 20 && building.parameters.width <= 29);
    assert.ok(building.parameters.height >= 8 && building.parameters.height <= 27);
    area += building.parameters.width * building.parameters.depth;
    const rect = footprint(building);
    for (const other of buildings.slice(i + 1)) assert.equal(overlap(rect, footprint(other)), false);
    for (const street of scheme.streets) {
      const road = street.axis === 'x'
        ? { minX: -100, maxX: 100, minZ: -5, maxZ: 5 }
        : { minX: -5, maxX: 5, minZ: -100, maxZ: 100 };
      assert.equal(overlap(rect, road), false);
    }
  }
  assert.ok(area / (4 * 95 * 95) > 0.75);
  assert.throws(() => generateWorld({ ...scheme, bounds: { minX: -100000, maxX: 100000, minZ: -100000, maxZ: 100000 }, lampSpacing: 1e6 }), /бюджет застройки/);
});

test('invalid roads, height data, seeds and excessive generation budgets fail before loops grow unbounded', () => {
  const invalid: WorldScheme[] = [
    { ...scheme, id: ' ' }, { ...scheme, seed: -1 }, { ...scheme, seed: 1.5 }, { ...scheme, seed: 0x100000000 },
    { ...scheme, baseHeight: NaN }, { ...scheme, slopeX: 0.11 }, { ...scheme, lampSpacing: 0 },
    { ...scheme, bounds: { ...scheme.bounds, maxX: Infinity } },
    { ...scheme, bounds: { ...scheme.bounds, maxX: -20 } },
    { ...scheme, streets: [] }, { ...scheme, streets: [scheme.streets[0], scheme.streets[0]] },
    { ...scheme, streets: [{ ...scheme.streets[0], width: 0 }] },
    { ...scheme, streets: [{ ...scheme.streets[0], coordinate: 19 }] },
    { ...scheme, streets: [scheme.streets[0], { ...scheme.streets[0], id: 'parallel', coordinate: 4 }] },
    { ...scheme, reserved: [{ minX: -1, maxX: 1, minZ: -1, maxZ: 1 }] },
    { ...scheme, reserved: [{ minX: 5, maxX: 50, minZ: 5, maxZ: 10 }] },
    { ...scheme, bounds: { minX: -1e6, maxX: 1e6, minZ: -20, maxZ: 20 }, lampSpacing: 2 },
  ];
  for (const input of invalid) assert.throws(() => generateWorld(input));
  assert.doesNotThrow(() => generateWorld({ ...scheme, seed: 0 }));
});
