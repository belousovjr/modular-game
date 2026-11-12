export interface WindowSettings {
  open: boolean;
  position: { left: number; top: number };
}

const key = (id: string) => `modular-game.window.${id}`;

export function readWindow(id: string): WindowSettings {
  const defaults = { open: false, position: { left: 16, top: 48 } };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(id)) ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return defaults;
    if ('open' in value && typeof value.open === 'boolean') defaults.open = value.open;
    if ('position' in value && value.position && typeof value.position === 'object') {
      const position = value.position;
      if ('left' in position && typeof position.left === 'number' && Number.isFinite(position.left) && position.left >= 0 &&
          'top' in position && typeof position.top === 'number' && Number.isFinite(position.top) && position.top >= 0) {
        defaults.position = { left: position.left, top: position.top };
      }
    }
  } catch { /* Хранилище недоступно или повреждено: используем значения по умолчанию. */ }
  return defaults;
}

export function writeWindow(id: string, patch: Partial<WindowSettings>) {
  try { localStorage.setItem(key(id), JSON.stringify({ version: 1, ...readWindow(id), ...patch })); }
  catch { /* При недоступном хранилище окно продолжает работать в памяти. */ }
}
