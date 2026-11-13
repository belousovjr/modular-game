import { parseSync } from 'rolldown/utils';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
const root = resolve('src');
let failures = 0;
// shortcut: headless.ts is self-contained, expand checked paths when private headless helpers are needed.
const moduleHeadless = path => path[0] === 'modules' && path.length === 3 && path[2] === 'headless.ts';
const headless = path => path[0] === 'simulation' || moduleHeadless(path);
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!/\.tsx?$/.test(path)) continue;
    const { program: file, errors } = parseSync(path, await readFile(path, 'utf8'));
    if (errors.length) throw new Error(`Cannot parse ${path}`);
    const owner = relative(root, path).split(sep);
    function fail(message) { console.error(`${relative(root, path)}: ${message}`); failures++; }
    function visit(node) {
      if (headless(owner) && ['JSXElement', 'JSXFragment'].includes(node.type)) fail('Headless code cannot use JSX');
      let spec;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) spec = node.source.value;
      if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee?.name === 'require')) {
        fail('Dynamic imports/require need an explicit boundary review; use static imports.');
      }
      if (spec) {
        const target = spec.startsWith('.') ? relative(root, resolve(dir, spec)).split(sep) : spec.split('/');
        if (headless(owner) && (!spec.startsWith('.') || !headless(target))) fail(`Headless code cannot import ${spec}`);
        if (owner[0] === 'core' && target[0] === 'modules') fail('Core cannot import feature modules');
        if (owner[0] === 'modules' && target[0] === 'modules' && owner[1] !== target[1] && !(target.length === 3 && /^index\.tsx?$/.test(target[2])) && !(headless(owner) && moduleHeadless(target))) fail(`Use the public module entry point: ${spec}`);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child); }
        else if (value && typeof value === 'object' && value.type) visit(value);
      }
    }
    visit(file);
  }
}
await walk(root);
if (failures) process.exit(1);
console.log('Module boundaries OK');
