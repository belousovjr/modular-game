export type SettingsSnapshot = Record<string, string>;
export const HISTORY_KEY = 'modular-game.history';
const keys = ['modular-game.modules', 'modular-game.categories', 'modular-game.module-preferences'];
const isKey = (key: string) => keys.includes(key) || /^modular-game\.window\.[\w-]+$/.test(key);
const encode = (snapshot: SettingsSnapshot) => JSON.stringify(Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))));

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
const status = (value: unknown) => value === 'working' || value === 'hidden' || value === 'archived';

export function validateSnapshot(value: unknown): SettingsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректный снимок настроек');
  const result: SettingsSnapshot = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'modular-game.camera') continue;
    if (!isKey(key) || typeof raw !== 'string') throw new Error(`Недопустимая настройка: ${key}`);
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data) || data.version !== 1) throw new Error(`Неизвестная версия настройки: ${key}`);
    const valid = key === 'modular-game.modules' ? strings(data.enabled) :
      key === 'modular-game.categories' ? strings(data.collapsed) :
      key === 'modular-game.module-preferences' ? (!('tab' in data) || status(data.tab)) && isRecord(data.statuses) && Object.values(data.statuses).every(status) :
      typeof data.open === 'boolean' && isRecord(data.position) && finite(data.position.left) && data.position.left >= 0 && finite(data.position.top) && data.position.top >= 0;
    if (!valid) throw new Error(`Некорректная настройка: ${key}`);
    result[key] = raw;
  }
  return result;
}

export function exportSettingsSnapshot(snapshot: SettingsSnapshot): SettingsSnapshot {
  const validated = validateSnapshot(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key === 'modular-game.modules' || key === 'modular-game.module-preferences')));
  const result: SettingsSnapshot = {};
  if (validated['modular-game.modules']) result['modular-game.modules'] = validated['modular-game.modules'];
  const preferences: unknown = JSON.parse(validated['modular-game.module-preferences'] ?? '{}');
  if (isRecord(preferences) && isRecord(preferences.statuses) && Object.keys(preferences.statuses).length) result['modular-game.module-preferences'] = JSON.stringify({ version: 1, statuses: preferences.statuses });
  return result;
}

export function parseSettingsFile(raw: string): SettingsSnapshot {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.settings)) throw new Error('Неизвестный формат файла настроек');
  const candidate: SettingsSnapshot = {};
  for (const [key, raw] of Object.entries(value.settings)) {
    if (key === 'modular-game.camera' || key === 'modular-game.categories' || /^modular-game\.window\./.test(key)) continue;
    if (typeof raw !== 'string') throw new Error(`Некорректная настройка: ${key}`);
    if (key === 'modular-game.module-preferences') {
      const preferences: unknown = JSON.parse(raw);
      if (!isRecord(preferences)) throw new Error('Некорректные статусы модулей');
      candidate[key] = JSON.stringify({ ...preferences, tab: 'working' });
    } else candidate[key] = raw;
  }
  return exportSettingsSnapshot(validateSnapshot(candidate));
}

export function mergeImportedSettings(current: SettingsSnapshot, imported: SettingsSnapshot): SettingsSnapshot {
  const result = { ...current };
  delete result['modular-game.modules'];
  if (imported['modular-game.modules']) result['modular-game.modules'] = imported['modular-game.modules'];
  const previous: unknown = JSON.parse(current['modular-game.module-preferences'] ?? '{}');
  const next: unknown = JSON.parse(imported['modular-game.module-preferences'] ?? '{}');
  result['modular-game.module-preferences'] = JSON.stringify({
    version: 1, tab: isRecord(previous) && status(previous.tab) ? previous.tab : 'working',
    statuses: isRecord(next) ? next.statuses ?? {} : {},
  });
  return result;
}

export function createSettingsHistory(storage: () => Storage, now = () => performance.now()) {
  function capture(): SettingsSnapshot {
    const source = storage();
    const names = new Set(keys);
    for (let index = 0; index < source.length; index++) {
      const key = source.key(index);
      if (key && isKey(key)) names.add(key);
    }
    return Object.fromEntries([...names].flatMap(key => {
      const value = source.getItem(key);
      return value === null ? [] : [[key, value]];
    }));
  }
  let initialized = false;
  let entries: SettingsSnapshot[] = [];
  let cursor = 0;
  let saved: string | null = null;
  let depth = 0;
  let replaying = false;
  let group: string | undefined;
  let groupTime = 0;
  const listeners = new Set<() => void>();
  let state = { canUndo: false, canRedo: false, dirty: true, error: '' };
  function publish(error = state.error) {
    state = { canUndo: cursor > 0, canRedo: cursor < entries.length - 1, dirty: saved !== encode(entries[cursor] ?? {}), error };
    listeners.forEach(listener => listener());
  }
  function initialize() {
    if (initialized) return;
    initialized = true;
    try {
      const current = exportSettingsSnapshot(capture());
      entries = [current];
      const value: unknown = JSON.parse(storage().getItem(HISTORY_KEY) ?? 'null');
      if (value && typeof value === 'object' && 'version' in value && value.version === 1 && 'entries' in value && Array.isArray(value.entries) && value.entries.length &&
          'cursor' in value && typeof value.cursor === 'number' && Number.isInteger(value.cursor) && value.cursor >= 0 && value.cursor < value.entries.length) {
        const restored = value.entries.map(exportSettingsSnapshot);
        if (encode(restored[value.cursor]!) === encode(current)) {
          const restoredCursor = value.cursor;
          entries = [];
          restored.forEach((snapshot, index) => {
            if (!entries.length || encode(snapshot) !== encode(entries[entries.length - 1]!)) entries.push(snapshot);
            if (index <= restoredCursor) cursor = entries.length - 1;
          });
          if (entries.length !== restored.length || JSON.stringify(restored) !== JSON.stringify(value.entries)) persist();
        }
      }
    } catch { if (!entries.length) entries = [{}]; }
    publish();
  }
  // shortcut: full snapshots suit the small personal config; revisit if history approaches storage quota.
  function persist() {
    try { storage().setItem(HISTORY_KEY, JSON.stringify({ version: 1, entries, cursor })); publish(''); }
    catch { publish('Не удалось сохранить историю в localStorage. История доступна только до перезагрузки.'); }
  }
  function record(nextGroup?: string) {
    const next = exportSettingsSnapshot(capture());
    if (encode(next) === encode(entries[cursor]!)) return;
    const time = now();
    const merge = nextGroup !== undefined && group === nextGroup && time - groupTime < 1000 && cursor > 0 && cursor === entries.length - 1;
    entries = entries.slice(0, cursor + 1);
    if (merge) entries[cursor] = next;
    else { entries.push(next); cursor++; }
    group = nextGroup;
    groupTime = time;
    persist();
  }
  function apply(snapshot: SettingsSnapshot) {
    snapshot = mergeImportedSettings(capture(), snapshot);
    const source = storage();
    for (const key of Object.keys(capture())) if (!(key in snapshot)) source.removeItem(key);
    for (const [key, value] of Object.entries(snapshot)) source.setItem(key, value);
  }
  function restore(snapshot: SettingsSnapshot, refresh: () => void) {
    const previous = capture();
    replaying = true;
    try { apply(snapshot); refresh(); }
    catch (error) {
      try { apply(previous); refresh(); }
      catch { publish('Не удалось восстановить настройки. Перезагрузите страницу.'); }
      throw error;
    } finally { replaying = false; }
  }
  return {
    initialize,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    capture,
    write(key: string, value: string, nextGroup?: string) {
      if (replaying) return;
      if (!isKey(key)) throw new Error(`Недопустимая настройка: ${key}`);
      initialize();
      storage().setItem(key, value);
      if (!depth) record(nextGroup);
    },
    transaction<T>(action: () => T): T {
      initialize();
      depth++;
      try { return action(); }
      finally { if (--depth === 0 && !replaying) record(); }
    },
    undo(refresh: () => void) {
      initialize();
      if (!cursor) return;
      restore(entries[cursor - 1]!, refresh); cursor--; group = undefined; persist();
    },
    redo(refresh: () => void) {
      initialize();
      if (cursor >= entries.length - 1) return;
      restore(entries[cursor + 1]!, refresh); cursor++; group = undefined; persist();
    },
    import(snapshot: SettingsSnapshot, refresh: () => void) {
      initialize(); restore(exportSettingsSnapshot(snapshot), refresh); record();
    },
    markSaved(snapshot: SettingsSnapshot | null) { initialize(); saved = snapshot === null ? null : encode(exportSettingsSnapshot(snapshot)); group = undefined; publish(); },
  };
}

export const settingsHistory = createSettingsHistory(() => localStorage);
