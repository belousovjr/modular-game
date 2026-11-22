import type { IncomingMessage, ServerResponse } from 'node:http';
import { Pool } from 'pg';

export function createDbHealth(connectionString: string | undefined) {
  let pool: Pool | undefined;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405).end(JSON.stringify({ ok: false }));
      return;
    }
    try {
      if (!connectionString) {
        response.writeHead(503).end(JSON.stringify({ ok: false, database: 'unconfigured' }));
        return;
      }
      if (!pool) {
        pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
        pool.on('error', () => console.error('PostgreSQL idle connection failed'));
      }
      const result = await pool.query<{ ready: number }>('SELECT 1 AS ready');
      if (result.rows[0]?.ready !== 1) throw new Error('Unexpected health query result');
      response.writeHead(200).end(JSON.stringify({ ok: true, database: 'postgres' }));
    } catch {
      response.writeHead(503).end(JSON.stringify({ ok: false, database: 'unavailable' }));
    }
  }
  return {handle,close:()=>pool?.end()};
}
