import { moduleFactory } from '../src/core/modules.ts';
import { defineModule } from '../src/core/context.ts';
import { objectTemplatesModule } from '../src/modules/object-templates/index.ts';
import { objectRenderingModule } from '../src/modules/object-rendering/index.ts';
const define = moduleFactory<{}>();
defineModule({ id: 'rendering-types', title: '', category: 'Тесты', requires: { rendering: objectRenderingModule }, setup({ deps, scope }) {
  deps.rendering.setDistanceSource(() => null, scope);
  // @ts-expect-error distance coordinates must be numbers
  deps.rendering.setDistanceSource(() => ({ x: '0', y: 0, z: 0 }), scope);
  // @ts-expect-error transitive template dependency does not grant direct API access
  deps.templates.list();
  return {};
} });
defineModule({ id: 'template-types', title: '', category: 'Тесты', requires: { templates: objectTemplatesModule }, setup({ deps, scope }) {
  // @ts-expect-error template parameters currently accept only numbers
  deps.templates.resolve('building', { height: 'tall' });
  // @ts-expect-error LOD is selected by numeric index
  deps.templates.createModel('building', 'example', {}, scope, 'far');
  // @ts-expect-error transitive geometry dependency does not grant direct API access
  deps.geometry.validateParts([]);
  return {};
} });
const source = define({ id: 'source', category: 'Тесты', title: '', requires: {}, setup() { return { read: () => 42 }; } });
define({ id: 'consumer', category: 'Тесты', title: '', requires: { source }, setup({ deps }) {
  const answer: number = deps.source.read();
  // @ts-expect-error undeclared modules are inaccessible
  deps.other.read();
  return answer;
} });
define({ id: 'isolated', category: 'Тесты', title: '', requires: {}, setup({ deps }) {
  // @ts-expect-error importing a definition does not grant access to its API
  deps.source.read();
  return {};
} });

// @ts-expect-error every module must declare its category
define({ id: 'uncategorized', title: '', requires: {}, setup() {} });

define({ id: 'tested', category: 'Тесты', title: '', requires: { source }, setup() { return { value: 1 }; },
  test: { durationSeconds: 1, setup({ api, deps }) {
    const value: number = api.value + deps.source.read();
    // @ts-expect-error test scenarios cannot bypass declared dependencies
    deps.other.read();
    // @ts-expect-error own API stays typed in scenarios
    api.missing();
    return () => { void value; };
  } },
});
