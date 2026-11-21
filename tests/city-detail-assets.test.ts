import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { citySource } from '../src/modules/world/city.ts';
import { splitCityDetails } from '../src/modules/world/detail-assets.ts';
import { cityCollision } from '../src/modules/world/headless.ts';
import { collectFacadeBelts } from '../src/modules/world/facade-trim.ts';
import { getBuildingInteriorSources } from '../src/modules/world/building-profiles.ts';

test('streamed visual details leave prepared collisions, roof footprints and distant trim intact', () => {
  const assets = new Set<number>();
  const startup = splitCityDetails(citySource, (index, details) => {
    assert.equal(details, citySource.chunks[index].details);
    assets.add(index);
    return `world-details/${index}.json`;
  });
  assert.ok(assets.size > 0);
  assert.ok(JSON.stringify(startup).length < JSON.stringify(citySource).length * .8);
  const digest = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(digest(cityCollision(startup)), digest(cityCollision(citySource)));
  function roofs(city: typeof citySource) {
    return getBuildingInteriorSources(city).map(({ id, facade }) => {
      const points: number[] = [];
      for (let i = 0; i < facade.indices.length; i += 3) {
        const vertices = facade.indices.slice(i, i + 3);
        if (vertices.every(v => facade.uvs?.[v * 2] === -2)) {
          for (const v of vertices) points.push(...facade.positions.slice(v * 3, v * 3 + 3));
        }
      }
      return { id, points };
    });
  }
  assert.equal(digest(roofs(startup)), digest(roofs(citySource)));
  for (const [index, chunk] of startup.chunks.entries())
    assert.deepEqual(collectFacadeBelts(chunk.details ?? []), collectFacadeBelts(citySource.chunks[index].details ?? []));
});

test('nearby street assets retain signal recipes and static markings without changing collision', async () => {
  const { splitStreetAssets } = await import('../src/modules/world/street-assets.ts');
  const signals = new Map();
  const markings = new Set();
  const startup = splitStreetAssets(citySource, 128, (index, asset) => {
    for (const signal of asset.signals) signals.set(signal.key, signal);
    for (const marking of asset.meshes) markings.add(marking);
    return `world-streets/${index}.json`;
  });
  const expectedSignals = citySource.placements.filter(p => p.templateId === 'city/signal');
  const expectedMarkings = citySource.chunks.flatMap(chunk => chunk.meshes.filter(mesh => mesh.surface === 'marking'));
  assert.equal(signals.size, expectedSignals.length);
  assert.equal(markings.size, expectedMarkings.length);
  for (const signal of expectedSignals) assert.equal(signals.get(signal.key), signal);
  for (const marking of expectedMarkings) assert.ok(markings.has(marking));
  assert.deepEqual(startup.trafficLayout?.crosswalks,
    citySource.trafficLayout?.crosswalks.map(({center,direction,outline})=>({center,direction,outline})));
  assert.ok(!startup.placements.some(p => p.templateId === 'city/signal'));
  assert.ok(startup.chunks.every(chunk => chunk.meshes.every(mesh => mesh.surface !== 'marking')));
  const digest = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(digest(cityCollision(startup)), digest(cityCollision(citySource)));
});

test('road recipes reproduce prepared road vertices and faces exactly', async () => {
  const { buildRoadRecipe, generateRoad } = await import('../src/modules/world/road-recipe.ts');
  const { gzipSync } = await import('node:zlib');
  const roads = citySource.chunks.flatMap(chunk => chunk.meshes.filter(mesh => mesh.surface === 'road'));
  const recipes = roads.map(road => {
    const recipe = buildRoadRecipe(road);
    assert.ok(recipe);
    assert.deepEqual(generateRoad(recipe), road);
    return recipe;
  });
  assert.ok(gzipSync(JSON.stringify(recipes)).length < gzipSync(JSON.stringify(roads)).length);
});
