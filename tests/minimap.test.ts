import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeStreetReader, mapHeading, mapProjection} from '../src/modules/minimap/map.ts';
import {getWorldMap} from '../src/modules/world/map.ts';
import {citySource} from '../src/modules/world/city.ts';

test('minimap projects north up and preserves the last heading when looking vertically', () => {
  const projection = mapProjection({minX:-100,maxX:200,minZ:-30,maxZ:70});
  assert.deepEqual([projection.width,projection.height,projection.x(-100),projection.y(70)], [300,100,0,0]);
  assert.equal(projection.x(0),100);
  assert.equal(projection.y(0),70);
  assert.equal(mapHeading(0,1,0),0);
  assert.equal(mapHeading(1,0,0),Math.PI/2);
  assert.equal(mapHeading(0,-1,0),Math.PI);
  assert.equal(mapHeading(-1,0,0),-Math.PI/2);
  assert.equal(mapHeading(0,0,1.5),1.5);
});

test('door addresses resolve at generated entrances and estimates are distinct on each street', () => {
  const map = getWorldMap(citySource);
  assert.ok(map.doors.length > 1000);
  assert.ok(map.doors.every(door => door.address?.street && door.address.number));
  const exact = map.doors.find(door => door.address?.estimated === false);
  const estimated = map.doors.filter(door => door.address?.estimated === true);
  assert.ok(exact && estimated.length > 0);
  const reader = makeStreetReader(map);
  assert.deepEqual(reader(exact.x,exact.z).address,exact.address);
  assert.equal(reader(100000,100000).address,undefined);
  assert.equal(reader(100000,100000).street,'');
  const ids = estimated.map(door => `${door.address?.street.toLowerCase()}:${door.address?.number}`);
  assert.equal(new Set(ids).size,ids.length);
});
