import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Offline preparation from the pinned City of Chicago GeoJSON; never downloaded by the game.
const input = process.argv[2];
if (!input) throw Error('Usage: node scripts/prepare-river-north.mjs /path/to/Transportation.geojson');
const vertical = ['SEDGWICK', 'ORLEANS', 'FRANKLIN', 'WELLS', 'LA SALLE', 'CLARK', 'DEARBORN', 'STATE', 'WABASH'];
const horizontal = ['GRAND', 'OHIO', 'ONTARIO', 'ERIE', 'HURON', 'SUPERIOR', 'CHICAGO', 'INSTITUTE', 'PEARSON', 'CHESTNUT', 'LOCUST', 'DELAWARE', 'WALTON', 'OAK'];
const features = [];
const stream = createReadStream(input);
const hash = createHash('sha256');
stream.on('data', chunk => hash.update(chunk));
for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
  if (!line.startsWith('{ "type": "Feature"')) continue;
  const f = JSON.parse(line.trim().replace(/,$/, ''));
  if (f.geometry?.type !== 'LineString') continue;
  const p = f.properties;
  if (!((p.PRE_DIR === 'N' && vertical.includes(p.STREET_NAM)) || (['E', 'W'].includes(p.PRE_DIR) && horizontal.includes(p.STREET_NAM)))) continue;
  if (!f.geometry.coordinates.some(([lon, lat]) => lon > -87.639 && lon < -87.626 && lat > 41.8915 && lat < 41.9015)) continue;
  features.push({ type: 'Feature', properties: { OBJECTID: p.OBJECTID, PRE_DIR: p.PRE_DIR, STREET_NAM: p.STREET_NAM, STREET_TYP: p.STREET_TYP }, geometry: f.geometry });
}
assert.equal(hash.digest('hex'), '212bfb7e1adc160c66b80d791a2f5f4387dc2fbf1a934ed76b5db8f4f88a2904', 'Unexpected source version');
const origin = { longitude: -87.6333, latitude: 41.896 };
const project = ([lon, lat]) => [(lon - origin.longitude) * 111320 * Math.cos(origin.latitude * Math.PI / 180), (lat - origin.latitude) * 111320];
const bounds = { minX: -480, maxX: 608, minZ: -512, maxZ: 624 };
const coordinate = (name, axis) => {
  const values = features.filter(f => f.properties.STREET_NAM === name).flatMap(f => f.geometry.coordinates.map(p => project(p)[axis === 'x' ? 1 : 0])).sort((a, b) => a - b);
  assert.ok(values.length, `Missing ${name}`);
  return Math.round(values[Math.floor(values.length / 2)]);
};
const streets = [...vertical.map(name => ({ name, axis: 'z', coordinate: coordinate(name, 'z') })), ...horizontal.map(name => ({ name, axis: 'x', coordinate: coordinate(name, 'x') }))].map(s => ({
  id: s.name.toLowerCase().replaceAll(' ', '-'), axis: s.axis, coordinate: s.coordinate,
  width: ['LA SALLE', 'CHICAGO', 'OHIO', 'ONTARIO'].includes(s.name) ? 24 : 6,
  sidewalk: ['LA SALLE', 'CHICAGO', 'OHIO', 'ONTARIO'].includes(s.name) ? 4 : 2,
}));
const at = name => { const s = streets.find(s => s.id === name); assert.ok(s); return s.coordinate; };
for (const s of streets) {
  if (s.id === 'sedgwick') s.start = at('erie');
  if (s.id === 'franklin') s.end = at('walton');
  if (s.id === 'institute') { s.start = at('orleans'); s.end = at('wells'); }
  if (s.id === 'locust') s.end = at('wells');
  if (s.id === 'pearson') s.start = at('dearborn');
  if (s.id === 'delaware') s.start = at('la-salle');
  if (s.id === 'walton') s.start = at('orleans');
}
const source = { repository: 'https://github.com/Chicago/osd-street-center-line', commit: 'ee45d118cec6760619568a5675278454d6324cf1', file: 'data/Transportation.geojson', license: 'MIT', origin, metersPerUnit: 1 };
const output = new URL('../src/modules/world/data/', import.meta.url);
await writeFile(new URL('river-north-source.geojson', output), JSON.stringify({ type: 'FeatureCollection', features }, null, 2) + '\n');
await writeFile(new URL('river-north.json', output), JSON.stringify({ source, bounds, streets }, null, 2) + '\n');
console.log(`${features.length} source segments, ${streets.length} simplified street corridors`);
