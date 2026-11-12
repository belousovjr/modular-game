import type { ModuleDefinition } from './modules.ts';

export function groupModules<C>(modules: readonly ModuleDefinition<C>[]) {
  function dependencies(module: ModuleDefinition<C>, ids = new Set<string>()) {
    for (const dependency of Object.values(module.requires)) {
      if (ids.has(dependency.id)) continue;
      ids.add(dependency.id);
      dependencies(dependency, ids);
    }
    return ids;
  }
  const groups = new Map<string, ModuleDefinition<C>[]>();
  for (const module of modules) {
    const group = groups.get(module.category) ?? [];
    group.push(module);
    groups.set(module.category, group);
  }
  return [...groups].map(([title, entries]) => ({
    title,
    modules: entries.sort((a, b) => dependencies(a).size - dependencies(b).size || a.title.localeCompare(b.title, 'ru')),
    dependencyCount: new Set(entries.flatMap(module => [...dependencies(module)])).size,
  })).sort((a, b) => a.dependencyCount - b.dependencyCount || b.modules.length - a.modules.length || a.title.localeCompare(b.title, 'ru'));
}

export function formatModuleGroups<C>(modules: readonly ModuleDefinition<C>[]) {
  return groupModules(modules)
    .map(group => `${group.modules.map(module => module.title).join(', ')} (${group.title})`)
    .join('\n');
}
