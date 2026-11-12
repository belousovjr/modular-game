import { validateSnapshot, type SettingsSnapshot } from './settings-history.ts';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open('modular-game', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('settings'); };
    request.onsuccess = () => { if (blocked) request.result.close(); else { request.result.onversionchange = () => request.result.close(); resolve(request.result); } };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('IndexedDB заблокирована другой вкладкой')); };
  });
}
export async function readSavedSettings(): Promise<SettingsSnapshot | null> {
  const db = await openDatabase();
  let legacyCamera = false;
  try {
    const snapshot = await new Promise<SettingsSnapshot | null>((resolve, reject) => {
      const transaction = db.transaction('settings', 'readonly');
      const request = transaction.objectStore('settings').get('current');
      transaction.oncomplete = () => {
        try {
          const value: unknown = request.result;
          if (value === undefined) { resolve(null); return; }
          if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('settings' in value)) throw new Error('Неизвестная версия сохранения');
          legacyCamera = !!value.settings && typeof value.settings === 'object' && 'modular-game.camera' in value.settings;
          resolve(validateSnapshot(value.settings));
        } catch (error) { reject(error); }
      };
      transaction.onabort = () => reject(transaction.error);
    });
    if (legacyCamera && snapshot) await saveSettings(snapshot);
    return snapshot;
  } finally { db.close(); }
}
export async function saveSettings(snapshot: SettingsSnapshot): Promise<void> {
  const settings = validateSnapshot(snapshot);
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put({ version: 1, settings }, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
