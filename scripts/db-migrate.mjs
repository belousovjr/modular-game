import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED is required');
const client = new Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(await readFile(new URL('../db/001-characters.sql', import.meta.url), 'utf8'));
  await client.query('COMMIT');
  console.log('001-characters.sql applied');
} finally { await client.end(); }
