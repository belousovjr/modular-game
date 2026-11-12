import { resolveModules, type ModuleDefinition } from './modules.ts';

export const PREFERENCES_STORAGE_KEY = 'modular-game.module-preferences';
export type ModuleStatus = 'working' | 'hidden' | 'archived';
export interface ModulePreferences { tab: ModuleStatus; statuses: Record<string, ModuleStatus> }
export function isModuleStatus(value: unknown): value is ModuleStatus {
  return value === 'working' || value === 'hidden' || value === 'archived';
}
export function readModulePreferences<C>(raw: string | null, registry: readonly ModuleDefinition<C>[]): ModulePreferences {
  const fallback: ModulePreferences = { tab: 'working', statuses: {} };
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
        !('tab' in value) || !isModuleStatus(value.tab) || !('statuses' in value) ||
        !value.statuses || typeof value.statuses !== 'object' || Array.isArray(value.statuses)) return fallback;
    const statuses: Record<string, ModuleStatus> = {};
    for (const [id, status] of Object.entries(value.statuses)) {
      if (registry.some(module => module.id === id) && isModuleStatus(status)) statuses[id] = status;
    }
    const preferences = { tab: value.tab, statuses };
    // Forced modules must remain runnable even when stored preferences are inconsistent.
    const forced = registry.filter(module => module.required || statuses[module.id] === 'hidden');
    for (const module of resolveModules(registry, forced.map(module => module.id))) {
      if (statuses[module.id] === 'archived') delete statuses[module.id];
    }
    return preferences;
  } catch { return fallback; }
}
export function selectModules<C>(registry: readonly ModuleDefinition<C>[], selected: readonly string[], statuses: Readonly<Record<string, ModuleStatus>>) {
  const available = (id: string) => resolveModules(registry, [id]).every(module => statuses[module.id] !== 'archived');
  const roots = registry.filter(module => module.required || statuses[module.id] === 'hidden' ||
    (selected.includes(module.id) && statuses[module.id] !== 'archived' && available(module.id)));
  const resolved = resolveModules(registry, roots.map(module => module.id));
  if (resolved.some(module => statuses[module.id] === 'archived')) throw new Error('Обязательный или скрытый модуль зависит от архивного');
  return resolved.map(module => module.id);
}
