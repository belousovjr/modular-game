import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

for (const failure of [false, true]) test(`dev ${failure ? 'stops Vite when room fails' : 'starts Vite without waiting for room readiness and cleans up both children'}`, { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'game-dev-'));
  await Promise.all(['scripts', 'server', 'node_modules/vite/bin'].map(dir => mkdir(join(root, dir), { recursive: true })));
  await writeFile(join(root, 'scripts/dev.mjs'), await readFile(new URL('../scripts/dev.mjs', import.meta.url)));
  await writeFile(join(root, 'server/index.ts'), `
    const fs = require('node:fs');

    setTimeout(() => {
      ${failure ? 'process.exit(7);' : "fs.writeFileSync('ready', 'yes');"}
    }, 1000);
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { fs.writeFileSync('room-stopped','yes'); process.exit(0); });
    console.log('FIXTURE_ROOM_BOOTING');
  `);
  await writeFile(join(root, 'node_modules/vite/bin/vite.js'), `
    const fs = require('node:fs');
    if (fs.existsSync('ready')) process.exit(91);
    fs.appendFileSync('vite-started', 'once');
    console.log('FIXTURE_VITE_READY');
    setInterval(() => {}, 1000);
    process.on('SIGTERM', () => { fs.writeFileSync('vite-stopped','yes'); process.exit(0); });
  `);
  const child = spawn(process.execPath, [join(root, 'scripts/dev.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGTERM'), 8000);
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
    if (!failure && output.includes('FIXTURE_VITE_READY') && output.includes('FIXTURE_ROOM_BOOTING')) child.kill('SIGTERM');
  });
  try {
    const [code] = await exited;
    assert.equal(code, failure ? 7 : 143);
    if (failure) assert.equal(await readFile(join(root, 'vite-stopped'), 'utf8'), 'yes');
    else {
      assert.equal(await readFile(join(root, 'vite-started'), 'utf8'), 'once');
      assert.equal(await readFile(join(root, 'room-stopped'), 'utf8'), 'yes');
      assert.equal(await readFile(join(root, 'vite-stopped'), 'utf8'), 'yes');
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    await rm(root, { recursive: true, force: true });
  }
});
