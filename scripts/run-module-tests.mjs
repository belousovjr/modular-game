import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { accessSync, constants, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { build, preview } from 'vite';
import { STORAGE_KEY, encodeSelection } from '../src/core/settings.ts';
import { validateFpsConfig, createFpsReport, printFpsReport } from './fps-report.mjs';

function chromiumPath() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const candidates = (process.env.PATH || '').split(delimiter).flatMap(directory =>
    ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].map(name => join(directory, name)));
  const cache = join(homedir(), '.cache/ms-playwright');
  try {
    for (const name of readdirSync(cache).filter(name => /^chromium-/.test(name)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
      candidates.push(join(cache, name, 'chrome-linux64/chrome'), join(cache, name, 'chrome-linux/chrome'));
    }
  } catch { /* Playwright's optional browser cache may not exist. */ }
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new Error('Chromium was not found. Install Chromium or set CHROME_BIN=/path/to/chrome.');
}

// Uses Chromium's DevTools protocol and Node's WebSocket; no automation dependency.
const fpsMode = process.argv.includes('--fps');
const reportPath = resolve('artifacts/fps-report.json');
let profile;
let browser;
let server;
let socket;
try {
  const config = fpsMode ? validateFpsConfig(JSON.parse(await readFile(new URL('../fps.config.json', import.meta.url), 'utf8'))) : undefined;
  const executable = chromiumPath();
  if (fpsMode && process.env.MODULE_TEST_IDS) throw new Error('test:fps always runs all scenarios; remove MODULE_TEST_IDS');
  let url = process.env.MODULE_TEST_URL || 'http://127.0.0.1:5175';
  if (fpsMode) {
    console.log('Building production app for FPS benchmark…');
    await build({ logLevel: 'silent' });
    server = await preview({ logLevel: 'silent', preview: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Cannot determine benchmark server port');
    url = `http://127.0.0.1:${address.port}`;
  }
  profile = await mkdtemp(join(tmpdir(), 'modular-game-test-'));
  browser = spawn(executable, [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    ...(fpsMode || process.argv.includes('--headless') ? ['--headless=new', '--enable-unsafe-swiftshader'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Chromium did not start: ${output}`)), 15000);
    browser.once('error', error => { clearTimeout(timeout); reject(error); });
    browser.once('exit', code => { clearTimeout(timeout); reject(new Error(`Chromium exited (${code}): ${output}`)); });
    browser.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timeout);
    if (response.error) request.reject(new Error(JSON.stringify(response.error))); else request.resolve(response.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 1800000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
  if (fpsMode) await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(encodeSelection([]))})` }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const ids = process.env.MODULE_TEST_IDS ? process.env.MODULE_TEST_IDS.split(',') : undefined;
  const seconds = process.env.MODULE_TEST_SECONDS === undefined ? undefined : Number(process.env.MODULE_TEST_SECONDS);
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300)) throw new Error('MODULE_TEST_SECONDS must be > 0 and <= 300');
  const response = await send('Runtime.evaluate', {
    expression: `(async () => {
      const deadline = performance.now() + 20000;
      while (!window.moduleTests) {
        if (performance.now() > deadline) throw new Error('App is not ready; enable modules and run the dev server');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const trigger = document.getElementById('modules-trigger');
      if (trigger.getAttribute('aria-expanded') === 'false') { trigger.click(); await nextPaint(); }
      if (${fpsMode}) {
        // Select the entire registry through the same UI users apply, including non-default modules.
        for (const checkbox of document.querySelectorAll('#modules [role="checkbox"]')) {
          if (checkbox.getAttribute('aria-checked') !== 'true' && !checkbox.disabled) { checkbox.click(); await nextPaint(); }
        }
        if (document.getElementById('apply').disabled === false) { document.getElementById('apply').click(); await nextPaint(); }
        const checkboxes = [...document.querySelectorAll('#modules [role="checkbox"]')];
        if (!checkboxes.length || checkboxes.some(checkbox => checkbox.getAttribute('aria-checked') !== 'true')) throw new Error('Could not enable the entire module registry');
      }
      const tests = window.moduleTests.list();
      const enabledModules = [...document.querySelectorAll('#modules [data-module-id]')].filter(row => row.querySelector('[role="checkbox"]').getAttribute('aria-checked') === 'true')
        .map(row => ({ id: row.dataset.moduleId, hasTest: tests.some(test => test.id === row.dataset.moduleId) }));
      if (!tests.length) throw new Error('No enabled module tests');
      const smokeTest = tests.at(-1);
      document.getElementById('test-' + smokeTest.id).click();
      await nextPaint();
      if (!window.moduleTests.getState().running || !document.querySelector('.game-controls').inert || !document.querySelector('[role="progressbar"]')) throw new Error('Test UI did not lock controls or show progress');
      document.getElementById('stop-tests').click();
      await nextPaint();
      if (window.moduleTests.getState().running || document.querySelector('.game-controls').inert || window.moduleTests.getState().results[0]?.status !== 'cancelled') throw new Error('Stop did not restore controls');
      document.getElementById('test-all').click();
      await nextPaint();
      if (!window.moduleTests.getState().running || window.moduleTests.getState().total !== tests.length) throw new Error('Play all did not queue every enabled module');
      if (tests.length > 1 && document.querySelectorAll('[role="progressbar"]').length !== 2) throw new Error('Queue progress is missing');
      document.getElementById('stop-tests').click();
      await nextPaint();
      const canvas = document.querySelector('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const environment = { userAgent: navigator.userAgent, width: canvas.width, height: canvas.height,
        devicePixelRatio, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown' };
      const results = await window.moduleTests.run(${JSON.stringify(ids) ?? 'undefined'}, ${seconds ?? 'undefined'});
      await nextPaint();
      if (window.moduleTests.getState().running || document.querySelector('.game-controls').inert) throw new Error('Completion did not restore controls');
      if (results.length > 1 && !document.getElementById('test-summary')) throw new Error('Results summary is missing');
      document.getElementById('close-test-results').click();
      await nextPaint();
      if (document.querySelector('.test-panel')) throw new Error('Results did not close');
      if (window.moduleTests.getState().results.length !== results.length) throw new Error('Closing the panel erased results');
      return { uiChecks: { play: true, playAll: true, overallProgress: tests.length > 1, summary: results.length > 1, closeResults: true, controlsLocked: true, progress: true, stop: true, controlsRestored: true }, environment, enabledModules, results };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  if (fpsMode) {
    const report = createFpsReport(response.result.value, config);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    printFpsReport(report, reportPath);
    if (!report.passed) process.exitCode = 1;
  } else {
    console.log(JSON.stringify(response.result.value, null, 2));
    if (response.result.value.results.some(result => result.status !== 'completed')) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  if (fpsMode) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ version: 2, measuredAt: new Date().toISOString(), passed: false, failures: [error.message] }, null, 2) + '\n');
    console.error(`Failure report: ${reportPath}`);
  }
  process.exitCode = 1;
} finally {
  socket?.close();
  browser?.kill();
  if (browser) await new Promise(resolve => { if (!browser.pid || browser.exitCode !== null || browser.signalCode !== null) resolve(); else browser.once('exit', resolve); });
  if (server) await new Promise((resolve, reject) => { server.httpServer.closeAllConnections(); server.httpServer.close(error => error ? reject(error) : resolve()); });
  if (profile) await rm(profile, { recursive: true, force: true });
}
