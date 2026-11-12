import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCollapsedCategories } from '../src/core/settings.ts';

test('collapsed categories restore by name and reject invalid storage', () => {
  const names = ['Системы', 'Окружение'];
  const saved = JSON.stringify({ version: 1, collapsed: ['Окружение', 'Удалена', 'Окружение'] });
  assert.deepEqual(readCollapsedCategories(saved, names), ['Окружение']);
  assert.deepEqual(readCollapsedCategories(JSON.stringify({ version: 1, collapsed: [] }), names), []);
  for (const raw of [null, '{', '{}', '{"version":2,"collapsed":["Системы"]}', '{"version":1,"collapsed":[5]}']) {
    assert.deepEqual(readCollapsedCategories(raw, names), []);
  }
});
