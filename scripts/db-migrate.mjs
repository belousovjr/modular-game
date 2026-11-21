import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';

for (const file of ['.env.local', '.env']) if (existsSync(file)) process.loadEnvFile(file);
const connectionString = process.env.DATABASE_URL_UNPOOLED;
if (!connectionString) throw new Error('DATABASE_URL_UNPOOLED is required');
const client = new Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  const directory = new URL('../db/', import.meta.url);
  const files = (await readdir(directory)).filter(file => /^\d+-.+\.sql$/.test(file)).sort();
  // shortcut: both migrations are idempotent, track applied versions before adding one-time data migrations.
  for (const file of files) await client.query(await readFile(new URL(file, directory), 'utf8'));
  await client.query('COMMIT');
  console.log('Applied: ' + files.join(', '));
} finally { await client.end(); }
