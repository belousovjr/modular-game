import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moduleFactory } from '../src/core/modules.ts';
import { formatModuleGroups, groupModules } from '../src/core/module-categories.ts';

const define = moduleFactory<{}>();
test('categories favor fewer unique dependencies, then more modules, then names', () => {
  const a = define({ id: 'a', title: 'А', category: 'Большая', requires: {}, setup() {} });
  const b = define({ id: 'b', title: 'Б', category: 'Большая', requires: {}, setup() {} });
  const c = define({ id: 'c', title: 'В', category: 'База', requires: {}, setup() {} });
  const d = define({ id: 'd', title: 'Г', category: 'Азбука', requires: {}, setup() {} });
  const e = define({ id: 'e', title: 'Я', category: 'Зависимые', requires: { a }, setup() {} });
  const f = define({ id: 'f', title: 'А', category: 'Зависимые', requires: { e, a }, setup() {} });
  const groups = groupModules([f, e, c, b, d, a]);
  assert.deepEqual(groups.map(group => group.title), ['Большая', 'Азбука', 'База', 'Зависимые']);
  assert.deepEqual(groups[0].modules.map(module => module.id), ['a', 'b']);
  assert.deepEqual(groups[3].modules.map(module => module.id), ['e', 'f']);
  assert.equal(groups[3].dependencyCount, 2);
  assert.deepEqual(groupModules([]), []);
});

test('module lists group names with the category at the end', () => {
  const a = define({ id: 'a', title: 'А', category: 'Мир', requires: {}, setup() {} });
  const b = define({ id: 'b', title: 'Б', category: 'Мир', requires: {}, setup() {} });
  const c = define({ id: 'c', title: 'В', category: 'Системы', requires: {}, setup() {} });
  assert.equal(formatModuleGroups([c, b, a]), 'А, Б (Мир)\nВ (Системы)');
  assert.equal(formatModuleGroups([c]), 'В (Системы)');
  assert.equal(formatModuleGroups([]), '');
});
