import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleFactory } from '../src/core/modules.ts';
import { readModulePreferences, selectModules } from '../src/core/module-preferences.ts';

const define = moduleFactory<{}>();
const base = define({ id: 'base', title: 'Base', category: 'Test', requires: {}, setup() { return {}; } });
const consumer = define({ id: 'consumer', title: 'Consumer', category: 'Test', requires: { base }, setup() { return {}; } });
const registry = [base, consumer];

test('hidden modules are forced on; archived modules and their working consumers stay off', () => {
  assert.deepEqual(selectModules(registry, [], { consumer: 'hidden' }), ['base', 'consumer']);
  assert.deepEqual(selectModules(registry, ['consumer'], { base: 'archived' }), []);
  assert.throws(() => selectModules(registry, [], { base: 'archived', consumer: 'hidden' }));
  assert.deepEqual(selectModules(registry, ['consumer'], {}), ['base', 'consumer']);
});

test('preferences restore only known statuses and repair forced dependencies', () => {
  assert.deepEqual(readModulePreferences('{', registry), { tab: 'working', statuses: {} });
  assert.deepEqual(readModulePreferences(JSON.stringify({ version: 2, tab: 'hidden', statuses: {} }), registry), { tab: 'working', statuses: {} });
  const raw = JSON.stringify({ version: 1, tab: 'archived', statuses: { base: 'archived', consumer: 'hidden', unknown: 'hidden' } });
  assert.deepEqual(readModulePreferences(raw, registry), { tab: 'archived', statuses: { consumer: 'hidden' } });
  assert.deepEqual(readModulePreferences(JSON.stringify({ version: 1, tab: 'hidden', statuses: { base: 'invalid' } }), registry), { tab: 'hidden', statuses: {} });
});
