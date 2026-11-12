import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { DropdownMenu, Flex, IconButton, Text } from '@radix-ui/themes';
import { Download, Settings, Upload } from 'lucide-react';
import { exportSettingsSnapshot, mergeImportedSettings, parseSettingsFile, settingsHistory } from './settings-history.ts';
import { readSavedSettings, saveSettings } from './settings-database.ts';

export function SettingsMenu({ disabled, restore }: { disabled: boolean; restore(): void }) {
  const history = useSyncExternalStore(settingsHistory.subscribe, settingsHistory.getSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const title = useRef(document.title);
  useEffect(() => {
    document.title = `${loaded && history.dirty ? '* ' : ''}${title.current}`;
  }, [loaded, history.dirty]);
  useEffect(() => () => { document.title = title.current; }, []);
  const busy = useRef(false);
  const restoreRef = useRef(restore);
  useEffect(() => { restoreRef.current = restore; }, [restore]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    settingsHistory.initialize();
    void readSavedSettings().then(snapshot => { if (active) settingsHistory.markSaved(snapshot); })
      .catch(() => { if (active) setError('Не удалось прочитать сохранение IndexedDB. Ctrl+S повторит попытку сохранения.'); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);

  async function save() {
    if (disabled || busy.current || !loaded) return;
    busy.current = true;
    setSaving(true);
    try {
      const snapshot = settingsHistory.capture();
      await saveSettings(snapshot);
      settingsHistory.markSaved(snapshot);
      setError('');
    } catch { setError('Не удалось сохранить настройки в IndexedDB. Изменения остаются несохранёнными.'); }
    finally { busy.current = false; setSaving(false); }
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !['KeyS', 'KeyZ'].includes(event.code)) return;
      const target = event.target;
      if (event.code === 'KeyZ' && target instanceof HTMLElement && target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      if (disabled || busy.current || event.repeat) return;
      if (event.code === 'KeyS') { void save(); return; }
      try {
          if (event.shiftKey) settingsHistory.redo(restore); else settingsHistory.undo(restore);
        setError('');
      } catch { setError('Не удалось восстановить настройки. Проверьте доступность localStorage.'); }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  function exportSettings() {
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, settings: exportSettingsSnapshot(settingsHistory.capture()) }, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'modular-game-settings.mgeng';
      anchor.click();
      URL.revokeObjectURL(url);
      setError('');
    } catch { setError('Не удалось экспортировать настройки.'); }
  }
  async function importSettings(file: File) {
    if (disabled || busy.current || !loaded) return;
    busy.current = true;
    setSaving(true);
    try {
      const snapshot = parseSettingsFile(await file.text());
      settingsHistory.import(mergeImportedSettings(settingsHistory.capture(), snapshot), () => restoreRef.current());
      const applied = settingsHistory.capture();
      await saveSettings(applied);
      settingsHistory.markSaved(applied);
      setError('');
    } catch (cause) { setError(`Не удалось импортировать и сохранить настройки: ${cause instanceof Error ? cause.message : String(cause)}`); }
    finally { busy.current = false; setSaving(false); }
  }
  const message = error || history.error;
  return <Flex align="center" gap="1">
    <DropdownMenu.Root>
      <DropdownMenu.Trigger><IconButton id="settings-trigger" data-save-state={saving ? 'saving' : !loaded ? 'loading' : history.dirty ? 'dirty' : 'saved'} size="1" variant="soft" aria-label="Настройки" disabled={disabled || saving}><Settings size={14} aria-hidden="true" /></IconButton></DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Item onSelect={exportSettings}><Download size={14} aria-hidden="true" />Экспортировать</DropdownMenu.Item>
        <DropdownMenu.Item disabled={!loaded} onSelect={() => input.current?.click()}><Upload size={14} aria-hidden="true" />Импортировать</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    <input ref={input} type="file" accept=".mgeng" hidden aria-label="Импорт настроек" onChange={event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = '';
      if (file) void importSettings(file);
    }} />
    {message && <Text size="1" color="red" role="alert">{message}</Text>}
  </Flex>;
}
