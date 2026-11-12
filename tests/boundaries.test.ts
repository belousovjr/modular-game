import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('import boundaries reject private, core-to-feature and browser dependencies', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'module-boundaries-'));
  const script = fileURLToPath(new URL('../scripts/check-boundaries.mjs', import.meta.url));
  try {
    for (const dir of ['core', 'simulation', 'modules/a']) mkdirSync(join(cwd, 'src', dir), { recursive: true });
    const run = () => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    const path = join(cwd, 'src/modules/a/index.ts');
    writeFileSync(path, 'import { b } from "../b/index.ts";');
    assert.equal(run().status, 0);
    writeFileSync(path, 'import { b } from "../b/index.tsx";');
    assert.equal(run().status, 0);
    for (const [file, source] of [
      [join(cwd, 'src/modules/a/panel.tsx'), 'import { b } from "../b/private.tsx"; const panel = <p />;'],
      [join(cwd, 'src/simulation/panel.tsx'), 'import { useState } from "react";'],
      [join(cwd, 'src/simulation/view.tsx'), 'const panel = <p />;'],
      [path, 'import { b } from "../b/private.ts";'],
      [join(cwd, 'src/core/test.ts'), 'export { b } from "../modules/b/index.ts";'],
      [join(cwd, 'src/simulation/test.ts'), 'import type { Scene } from "@babylonjs/core";'],
      [path, 'const module = import("../b/private.ts");'],
    ]) {
      writeFileSync(file, source);
      const result = run();
      assert.equal(result.status, 1, result.stderr);
      rmSync(file);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
