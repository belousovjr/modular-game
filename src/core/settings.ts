import { resolveModules, type ModuleDefinition } from './modules.ts';
export const STORAGE_KEY = 'modular-game.modules';
export function readSelection<C>(raw: string | null, registry: readonly ModuleDefinition<C>[], defaults: readonly string[]): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('enabled' in value) || !Array.isArray(value.enabled) || !value.enabled.every(id => typeof id === 'string')) return [...defaults];
    const known = new Set(registry.map(module => module.id));
    return resolveModules(registry, value.enabled.filter(id => known.has(id))).map(module => module.id);
  } catch { return [...defaults]; }
}
export function encodeSelection(ids: readonly string[]) { return JSON.stringify({ version: 1, enabled: ids }); }
