import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsHistory, exportSettingsSnapshot, mergeImportedSettings, HISTORY_KEY, parseSettingsFile, validateSnapshot } from '../src/core/settings-history.ts';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}
const key = 'modular-game.modules';
const value = (enabled: string[]) => JSON.stringify({ version: 1, enabled });

test('history groups one action, undoes/redoes, persists cursor, and cuts redo on a new edit', () => {
  const storage = memoryStorage();
  const history = createSettingsHistory(() => storage);
  let refreshes = 0;
  history.transaction(() => {
    history.write(key, value(['a']));
    history.write('modular-game.categories', JSON.stringify({ version: 1, collapsed: ['Test'] }));
  });
  const snapshot = history.capture();
  assert.equal(Object.keys(snapshot).length, 2);
  history.undo(() => { refreshes++; });
  assert.deepEqual(exportSettingsSnapshot(history.capture()), {});
  assert.ok(storage.getItem('modular-game.categories'));
  const restored = createSettingsHistory(() => storage);
  restored.initialize();
  assert.equal(restored.getSnapshot().canRedo, true);
  restored.redo(() => { refreshes++; });
  assert.deepEqual(exportSettingsSnapshot(restored.capture()), exportSettingsSnapshot(snapshot));
  restored.undo(() => {});
  restored.write(key, value(['b']));
  assert.equal(restored.getSnapshot().canRedo, false);
  assert.equal(refreshes, 2);
  assert.ok(storage.getItem(HISTORY_KEY));
});

test('continuous movements merge, discrete actions and pauses remain separate', () => {
  const storage = memoryStorage();
  let time = 0;
  const history = createSettingsHistory(() => storage, () => time);
  history.write(key, value(['a']), 'move');
  time = 500;
  history.write(key, value(['b']), 'move');
  history.undo(() => {});
  assert.equal(storage.getItem(key), null);
  history.redo(() => {});
  history.write(key, value(['c']));
  history.undo(() => {});
  assert.equal(storage.getItem(key), value(['b']));
  time = 2000;
  history.write(key, value(['d']), 'move');
  history.undo(() => {});
  assert.equal(storage.getItem(key), value(['b']));
});

test('saved marker compares snapshots and stays dirty for edits made during async saving', () => {
  const storage = memoryStorage();
  const actual = createSettingsHistory(() => storage);
  actual.write(key, value(['a']));
  const saving = actual.capture();
  actual.write(key, value(['b']));
  actual.markSaved(saving);
  assert.equal(actual.getSnapshot().dirty, true);
  actual.undo(() => {});
  assert.equal(actual.getSnapshot().dirty, false);
});

test('restore suppresses recording and rolls storage back if the scene cannot restore', () => {
  const storage = memoryStorage();
  const history = createSettingsHistory(() => storage);
  history.write(key, value(['a']));
  history.write(key, value(['b']));
  let attempts = 0;
  assert.throws(() => history.undo(() => {
    if (++attempts === 1) throw new Error('setup failed');
  }), /setup failed/);
  assert.equal(storage.getItem(key), value(['b']));
  history.undo(() => history.write(key, value(['ignored'])));
  assert.equal(storage.getItem(key), value(['a']));
  assert.equal(history.getSnapshot().canRedo, true);
});

test('import replaces only app preferences and is undoable; malformed imports are rejected', () => {
  const storage = memoryStorage();
  storage.setItem('unrelated', 'keep');
  const history = createSettingsHistory(() => storage);
  history.write(key, value(['a']));
  const snapshot = { [key]: value(['b']) };
  history.import(parseSettingsFile(JSON.stringify({ version: 1, settings: snapshot })), () => {});
  assert.deepEqual(exportSettingsSnapshot(history.capture()), snapshot);
  assert.equal(storage.getItem('unrelated'), 'keep');
  history.undo(() => {});
  assert.equal(storage.getItem(key), value(['a']));
  for (const raw of ['{', 'null', '{"version":2,"settings":{}}', '{"version":1,"settings":{"unknown":"{}"}}']) assert.throws(() => parseSettingsFile(raw));
  for (const invalid of [{ unrelated: '{}' }, { [key]: '{' }, { [key]: '{"version":1,"enabled":false}' }]) assert.throws(() => validateSnapshot(invalid));
});

test('corrupt or stale history never overrides current settings; history quota errors are visible', () => {
  const storage = memoryStorage();
  storage.setItem(HISTORY_KEY, '{');
  const history = createSettingsHistory(() => storage);
  history.initialize();
  assert.equal(history.getSnapshot().canUndo, false);
  history.write(key, value(['a']));
  storage.setItem(key, value(['external']));
  const reloaded = createSettingsHistory(() => storage);
  reloaded.initialize();
  assert.equal(reloaded.getSnapshot().canUndo, false);
  const setItem = storage.setItem;
  storage.setItem = (key, value) => { if (key === HISTORY_KEY) throw new Error('Quota'); setItem(key, value); };
  reloaded.write(key, value(['b']));
  assert.match(reloaded.getSnapshot().error, /историю/);
  assert.equal(storage.getItem(key), value(['b']));
});

test('camera stays independent of snapshots, dirty marker, import and undo', () => {
  const storage = memoryStorage();
  const history = createSettingsHistory(() => storage);
  const camera = 'modular-game.camera';
  storage.setItem(camera, 'first view');
  history.write(key, value(['a']));
  history.markSaved(history.capture());
  storage.setItem(camera, 'second view');
  assert.equal(history.getSnapshot().dirty, false);
  assert.equal(camera in history.capture(), false);
  history.import({ [key]: value(['b']), [camera]: 'legacy view' }, () => {});
  assert.equal(storage.getItem(camera), 'second view');
  history.undo(() => {});
  assert.equal(storage.getItem(camera), 'second view');
  history.redo(() => {});
  assert.equal(storage.getItem(camera), 'second view');
});

test('legacy history strips camera-only steps and retains the cursor', () => {
  const storage = memoryStorage();
  const camera = 'modular-game.camera';
  storage.setItem(camera, 'current local view');
  storage.setItem(key, value(['b']));
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, cursor: 3, entries: [
    { [key]: value(['a']), [camera]: 'view one' },
    { [key]: value(['a']), [camera]: 'view two' },
    { [key]: value(['b']), [camera]: 'view two' },
    { [key]: value(['b']), [camera]: 'view three' },
  ] }));
  const history = createSettingsHistory(() => storage);
  history.initialize();
  const migrated = JSON.parse(storage.getItem(HISTORY_KEY)!);
  assert.equal(migrated.entries.length, 2);
  assert.equal(migrated.cursor, 1);
  assert.equal(migrated.entries.some((entry: Record<string, string>) => camera in entry), false);
  history.undo(() => {});
  assert.equal(storage.getItem(key), value(['a']));
  assert.equal(storage.getItem(camera), 'current local view');
});

test('files contain module data only and preserve local interface settings on import', () => {
  const preferences = 'modular-game.module-preferences';
  const categories = 'modular-game.categories';
  const window = 'modular-game.window.modules';
  const current = {
    [key]: value(['a']),
    [preferences]: JSON.stringify({ version: 1, tab: 'archived', statuses: { a: 'working' } }),
    [categories]: JSON.stringify({ version: 1, collapsed: ['Test'] }),
    [window]: JSON.stringify({ version: 1, open: true, position: { left: 10, top: 20 } }),
  };
  const exported = exportSettingsSnapshot({ ...current, [categories]: 'irrelevant corrupt UI data' });
  assert.deepEqual(Object.keys(exported).sort(), [key, preferences].sort());
  assert.equal('tab' in JSON.parse(exported[preferences]!), false);
  const imported = parseSettingsFile(JSON.stringify({ version: 1, settings: {
    ...current,
    [preferences]: JSON.stringify({ version: 1, tab: 'hidden', statuses: { a: 'hidden' } }),
    [categories]: 'ignored legacy interface',
  } }));
  const merged = mergeImportedSettings(current, imported);
  assert.equal(merged[window], current[window]);
  assert.equal(merged[categories], current[categories]);
  assert.deepEqual(JSON.parse(merged[preferences]!), { version: 1, tab: 'archived', statuses: { a: 'hidden' } });
});

test('interface actions do not dirty settings, add history, or get reverted by module undo', () => {
  const storage = memoryStorage();
  const history = createSettingsHistory(() => storage);
  const preferences = 'modular-game.module-preferences';
  const window = 'modular-game.window.modules';
  const categories = 'modular-game.categories';
  history.write(key, value(['a']));
  history.markSaved(history.capture());
  const before = storage.getItem(HISTORY_KEY);
  history.write(preferences, JSON.stringify({ version: 1, tab: 'archived', statuses: {} }));
  storage.setItem(window, JSON.stringify({ version: 1, open: false, position: { left: 50, top: 100 } }));
  storage.setItem(categories, JSON.stringify({ version: 1, collapsed: ['Test'] }));
  assert.equal(storage.getItem(HISTORY_KEY), before);
  assert.equal(history.getSnapshot().dirty, false);
  history.write(key, value(['b']));
  history.undo(() => {});
  assert.equal(history.getSnapshot().dirty, false);
  assert.equal(JSON.parse(storage.getItem(preferences)!).tab, 'archived');
  assert.equal(JSON.parse(storage.getItem(window)!).open, false);
  assert.deepEqual(JSON.parse(storage.getItem(categories)!).collapsed, ['Test']);
});

test('legacy interface-only steps disappear without losing a redo branch', () => {
  const storage = memoryStorage();
  const window = 'modular-game.window.modules';
  storage.setItem(key, value(['a']));
  storage.setItem(window, 'current window');
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, cursor: 1, entries: [
    { [key]: value(['a']), [window]: 'old closed window' },
    { [key]: value(['a']), [window]: 'old open window' },
    { [key]: value(['b']), [window]: 'old moved window' },
  ] }));
  const history = createSettingsHistory(() => storage);
  history.initialize();
  assert.equal(history.getSnapshot().canUndo, false);
  assert.equal(history.getSnapshot().canRedo, true);
  history.redo(() => {});
  assert.equal(storage.getItem(key), value(['b']));
  assert.equal(storage.getItem(window), 'current window');
});
