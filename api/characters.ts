import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAccounts, type AccountConfig } from '../server/account.ts';
import { parsePacket, record } from '../src/simulation/online-protocol.ts';

export function createCharactersHandler(config: AccountConfig) {
  const accounts = createAccounts(config);
  return async (request: IncomingMessage & { body?: unknown }, response: ServerResponse) => {
    function reply(status: number, data: object) {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST');
      return reply(405, { error: 'Метод недоступен.' });
    }
    if (!accounts) return reply(503, { error: 'Сервис аккаунтов не настроен.' });
    const token = request.headers.authorization?.match(/^Bearer (\S{1,2048})$/i)?.[1];
    if (!token) return reply(401, { error: 'Войдите в аккаунт.' });
    try {
      const owner = await accounts.user(token);
      if (!owner) return reply(401, { error: 'Сессия недействительна.' });
      if (request.method === 'GET') return reply(200, { characters: await accounts.list(owner) });
      if (Number(request.headers['content-length']) > 1024) return reply(413, { error: 'Запрос слишком большой.' });
      let payload = request.body;
      if (payload === undefined) {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk);
          length += bytes.length;
          if (length > 1024) return reply(413, { error: 'Запрос слишком большой.' });
          chunks.push(bytes);
        }
        payload = Buffer.concat(chunks).toString('utf8');
      }
      if (typeof payload === 'string') payload = parsePacket(payload);
      const name = record(payload) && typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!/^[\p{L}\p{N}][\p{L}\p{N} _’-]{1,31}$/u.test(name))
        return reply(400, { error: 'Укажите имя из 2–32 букв, цифр, пробелов или дефисов.' });
      return reply(201, { character: await accounts.create(owner, name) });
    } catch {
      return reply(503, { error: 'Сервис персонажей временно недоступен.' });
    }
  };
}

export default createCharactersHandler(process.env);
