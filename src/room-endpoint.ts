export const roomSocketUrl = import.meta.env.VITE_GAME_WS_URL ||
  (import.meta.env.DEV ? 'ws://127.0.0.1:5177/room' : '');

export function roomHttpUrl(path: string) {
  if (import.meta.env.DEV && !import.meta.env.VITE_GAME_WS_URL && path.startsWith('/api/')) return path;
  if (!roomSocketUrl) throw new Error('Адрес игровой комнаты не настроен.');
  const room = new URL(roomSocketUrl);
  room.protocol = room.protocol === 'wss:' ? 'https:' : 'http:';
  return new URL(path, room);
}
