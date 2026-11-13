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
    for (const dir of ['core', 'simulation', 'modules/a', 'modules/b']) mkdirSync(join(cwd, 'src', dir), { recursive: true });
    const run = () => spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
    const path = join(cwd, 'src/modules/a/index.ts');
    writeFileSync(path, 'import { b } from "../b/index.ts";');
    assert.equal(run().status, 0);
    writeFileSync(path, 'import { b } from "../b/index.tsx";');
    assert.equal(run().status, 0);
    const headless = join(cwd, 'src/modules/a/headless.ts');
    for (const [file, source] of [
      [headless, 'export { b } from "../b/headless.ts";'],
      [headless, 'import { clock } from "../../simulation/authority.ts";'],
      [join(cwd, 'src/simulation/test.ts'), 'import { a } from "../modules/a/headless.ts";'],
    ]) {
      writeFileSync(file, source);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      rmSync(file);
    }
    const dependency = join(cwd, 'src/modules/b/headless.ts');
    writeFileSync(headless, 'export { b } from "../b/headless.ts";');
    writeFileSync(dependency, 'import { Scene } from "@babylonjs/core";');
    const transitive = run();
    assert.equal(transitive.status, 1, transitive.stderr);
    rmSync(headless);
    rmSync(dependency);
    for (const [file, source] of [
      [join(cwd, 'src/modules/a/panel.tsx'), 'import { b } from "../b/private.tsx"; const panel = <p />;'],
      [join(cwd, 'src/simulation/panel.tsx'), 'import { useState } from "react";'],
      [join(cwd, 'src/simulation/view.tsx'), 'const panel = <p />;'],
      [path, 'import { b } from "../b/private.ts";'],
      [join(cwd, 'src/core/test.ts'), 'export { b } from "../modules/b/index.ts";'],
      [join(cwd, 'src/simulation/test.ts'), 'import type { Scene } from "@babylonjs/core";'],
      [path, 'const module = import("../b/private.ts");'],
      [path, 'import { b } from "../b/headless.ts";'],
      [headless, 'import type { Scene } from "@babylonjs/core";'],
      [headless, 'import { defineModule } from "../../core/context.ts";'],
      [headless, 'export { a } from "./index.ts";'],
      [headless, 'import { b } from "../b/index.ts";'],
      [headless, 'export { helper } from "./private.ts";'],
      [join(cwd, 'src/simulation/test.ts'), 'import { a } from "../modules/a/index.ts";'],
    ]) {
      writeFileSync(file, source);
      const result = run();
      assert.equal(result.status, 1, result.stderr);
      rmSync(file);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
