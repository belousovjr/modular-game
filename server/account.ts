import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { Pool } from 'pg';

export type AccountConfig = { DATABASE_URL?: string; NEON_AUTH_BASE_URL?: string; NEON_AUTH_JWKS_URL?: string };
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

export function createAccounts(env: AccountConfig) {
  const { DATABASE_URL, NEON_AUTH_BASE_URL, NEON_AUTH_JWKS_URL } = env;
  if (!DATABASE_URL || !NEON_AUTH_BASE_URL || !NEON_AUTH_JWKS_URL) return undefined;
  const issuer = new URL(NEON_AUTH_BASE_URL).origin;
  const keys = createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL));
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  pool.on('error', () => console.error('PostgreSQL idle connection failed'));

  async function user(token: string) {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer, algorithms: ['EdDSA'], requiredClaims: ['sub', 'exp'],
      });
      return isUuid(payload.sub) ? payload.sub : undefined;
    } catch (error) {
      if (error instanceof errors.JOSEError) return undefined;
      throw error;
    }
  }

  return {
    user,
    async list(owner: string) {
      return (await pool.query<{ id: string; name: string }>(
        'SELECT id, name FROM public.characters WHERE user_id = $1 ORDER BY created_at, id', [owner],
      )).rows;
    },
    async create(owner: string, name: string) {
      return (await pool.query<{ id: string; name: string }>(
        'INSERT INTO public.characters (user_id, name) VALUES ($1, $2) RETURNING id, name', [owner, name],
      )).rows[0];
    },
    async owns(token: string, characterId: string) {
      const owner = await user(token);
      if (!owner || !isUuid(characterId)) return false;
      return !!(await pool.query(
        'SELECT 1 FROM public.characters WHERE id = $1 AND user_id = $2', [characterId, owner],
      )).rowCount;
    },
    close: () => pool.end(),
  };
}
