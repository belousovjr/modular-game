import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = new Set();
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}

function start(label, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  children.add(child);
  child.once('error', error => {
    children.delete(child);
    console.error(`${label}: ${error.message}`);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    stop(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1));
  });
}

process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));
start('Game room', ['server/index.ts']);
start('Vite', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5175', '--strictPort', ...process.argv.slice(2)]);
