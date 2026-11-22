import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { Plugin } from 'vite';

// Wait before forwarding, so even POST requests are sent only once.
export function devApi(target: URL, waitMs = 60_000): Plugin {
  let ready: Promise<boolean> | undefined;
  let closed = false;
  function listening() {
    return new Promise<boolean>(resolve => {
      const socket = createConnection({ host: target.hostname, port: Number(target.port) });
      const done = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(500, () => done(false));
    });
  }
  async function wait() {
    const deadline = Date.now() + waitMs;
    do {
      if (await listening()) return true;
      await delay(100);
    } while (!closed && Date.now() < deadline);
    return false;
  }
  return {
    name: 'dev-api-readiness',
    configureServer(server) {
      server.httpServer?.once('close', () => { closed = true; });
      server.middlewares.use(async (request, response, next) => {
        if (!request.url?.match(/^\/api(?:\/|\?|$)/)) return next();
        ready ??= wait().finally(() => { ready = undefined; });
        if (await ready) return next();
        if (!response.destroyed) response.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify({ error: 'Сервер комнаты не готов. Проверьте ошибки backend в терминале.' }));
      });
    },
  };
}
