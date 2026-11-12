import { readWindow, writeWindow } from './window-settings.ts';
import { useSyncExternalStore, type ReactNode } from 'react';

export interface Panel { id: string; title: string; content: ReactNode; open: boolean }
export function createPanels() {
  let entries: readonly Panel[] = [];
  const listeners = new Set<() => void>();
  function publish(next: readonly Panel[]) { entries = next; listeners.forEach(listener => listener()); }
  return {
    register(id: string, title: string, content: ReactNode) {
      if (entries.some(panel => panel.id === id)) throw new Error(`Панель уже зарегистрирована: ${id}`);
      publish([...entries, { id, title, content, open: readWindow(`details-${id}`).open }]);
      return () => publish(entries.filter(panel => panel.id !== id));
    },
    toggle(id: string) {
      const panel = entries.find(panel => panel.id === id);
      if (!panel) return;
      writeWindow(`details-${id}`, { open: !panel.open });
      publish(entries.map(entry => entry.id === id ? { ...entry, open: !entry.open } : entry));
    },
    close(id: string) { writeWindow(`details-${id}`, { open: false }); publish(entries.map(panel => panel.id === id ? { ...panel, open: false } : panel)); },
    getSnapshot: () => entries,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type Panels = ReturnType<typeof createPanels>;
export function usePanels(panels: Panels) { return useSyncExternalStore(panels.subscribe, panels.getSnapshot); }

