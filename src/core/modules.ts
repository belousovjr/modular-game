export interface Scope { onDispose(cleanup: () => void): void }
export interface ModuleContext<C, D> { core: C; deps: D; scope: Scope }
export interface ModuleDefinition<C, A = unknown> {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly requires: Readonly<Record<string, ModuleDefinition<C>>>;
  readonly required?: boolean;
  setup(context: ModuleContext<C, never>): A;
}
type APIs<D> = { readonly [K in keyof D]: D[K] extends ModuleDefinition<never, infer A> ? A : never };
export function moduleFactory<C>() {
  return function defineModule<const D extends Record<string, ModuleDefinition<C>>, A>(definition: {
    id: string; title: string; category: string; required?: boolean; requires: D;
    setup(context: ModuleContext<C, APIs<D>>): A;
  }): ModuleDefinition<C, A> {
    return definition as ModuleDefinition<C, A>;
  };
}

export function resolveModules<C>(registry: readonly ModuleDefinition<C>[], selected: readonly string[]) {
  const byId = new Map(registry.map(module => [module.id, module]));
  if (byId.size !== registry.length) throw new Error('Повторяющийся ID модуля');
  const ordered: ModuleDefinition<C>[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(id: string) {
    const module = byId.get(id);
    if (!module) throw new Error(`Неизвестный модуль: ${id}`);
    if (visiting.has(id)) throw new Error(`Циклическая зависимость: ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const dependency of Object.values(module.requires)) {
      if (byId.get(dependency.id) !== dependency) throw new Error(`Незарегистрированная зависимость: ${dependency.id}`);
      visit(dependency.id);
    }
    visiting.delete(id);
    done.add(id);
    ordered.push(module);
  }
  for (const module of registry) if (module.required) visit(module.id);
  for (const id of selected) visit(id);
  return ordered;
}

export function startModules<C>(registry: readonly ModuleDefinition<C>[], selected: readonly string[], core: C) {
  const ordered = resolveModules(registry, selected);
  const apis = new Map<string, unknown>();
  const cleanups: (() => void)[] = [];
  function dispose() {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    apis.clear();
    if (errors.length) throw new AggregateError(errors, 'Ошибка остановки модулей');
  }
  try {
    for (const module of ordered) {
      const deps = Object.fromEntries(Object.entries(module.requires).map(([name, dep]) => [name, apis.get(dep.id)]));
      const api = module.setup({ core, deps: deps as never, scope: { onDispose: cleanup => cleanups.push(cleanup) } });
      apis.set(module.id, api);
    }
  } catch (error) {
    try { dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Ошибка запуска и очистки'); }
    throw error;
  }
  return { dispose, ids: ordered.map(module => module.id) };
}
