import { moduleFactory } from '../src/core/modules.ts';
const define = moduleFactory<{}>();
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
