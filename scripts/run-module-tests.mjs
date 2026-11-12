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
const headless = process.argv.includes('--headless') || (fpsMode && !process.argv.includes('--headed'));
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
    ...(headless ? ['--headless=new', '--enable-unsafe-swiftshader'] : []),
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
      const moduleList = document.getElementById('modules');
      const categories = Array.from({ length: 30 }, () => moduleList.firstElementChild.cloneNode(true));
      try {
        moduleList.append(...categories); await nextPaint();
        const controls = [document.getElementById('test-all'), document.getElementById('reset'), document.querySelector('[role="tablist"]')];
        const positions = controls.map(control => control.getBoundingClientRect().top);
        if (moduleList.scrollHeight <= moduleList.clientHeight || moduleList.clientHeight > Math.min(420, innerHeight * 0.5) + 1) throw new Error('Module list is not height-limited');
        moduleList.focus();
        moduleList.scrollTop = moduleList.scrollHeight; await nextPaint();
        if (moduleList.scrollWidth > moduleList.clientWidth + 1) throw new Error('Module list has horizontal overflow');
        if (moduleList.scrollTop <= 0 || controls.some((control, index) => control.getBoundingClientRect().top !== positions[index])) throw new Error('Module list scrolling moved the controls');
      } finally { categories.forEach(category => category.remove()); moduleList.scrollTop = 0; }

      if (${fpsMode}) {
        // Enable the entire registry through the UI, including non-default modules.
        for (const checkbox of document.querySelectorAll('#modules [role="checkbox"]')) {
          if (checkbox.getAttribute('aria-checked') !== 'true' && !checkbox.disabled) { checkbox.click(); await nextPaint(); }
        }
        const checkboxes = [...document.querySelectorAll('#modules [role="checkbox"]')];
        if (!checkboxes.length || checkboxes.some(checkbox => checkbox.getAttribute('aria-checked') !== 'true')) throw new Error('Could not enable the entire module registry');
      }
      if (!${fpsMode}) {
        document.getElementById('reset').click(); await nextPaint();
        const camera = JSON.parse(localStorage.getItem('modular-game.camera'));
        if (camera.alpha !== -Math.PI / 2 || camera.beta !== 1.05 || camera.radius !== 12 || camera.target.x !== 0 || camera.target.y !== 1 || camera.target.z !== 0) throw new Error('Reset did not restore the default camera');
      }
      const tests = window.moduleTests.list();
      const enabledModules = [...document.querySelectorAll('#modules [data-module-id]')].filter(row => row.querySelector('[role="checkbox"]').getAttribute('aria-checked') === 'true')
        .map(row => ({ id: row.dataset.moduleId, hasTest: tests.some(test => test.id === row.dataset.moduleId) }));
      if (!tests.length) throw new Error('No enabled module tests');
      const toggleTest = tests.find(test => !document.querySelector('#modules [data-module-id="' + test.id + '"] [role="checkbox"]').disabled);
      if (toggleTest) {
        const checkbox = () => document.querySelector('#modules [data-module-id="' + toggleTest.id + '"] [role="checkbox"]');
        checkbox().click(); await nextPaint();
        if (window.moduleTests.list().some(test => test.id === toggleTest.id) || !document.getElementById('test-' + toggleTest.id).disabled) throw new Error('Disabling a module did not immediately stop its test');
        const cameraBeforeEnable = localStorage.getItem('modular-game.camera');
        checkbox().click(); await nextPaint();
        if (localStorage.getItem('modular-game.camera') !== cameraBeforeEnable) throw new Error('Module restart changed the camera');
        if (!window.moduleTests.list().some(test => test.id === toggleTest.id) || document.getElementById('test-' + toggleTest.id).disabled) throw new Error('Enabling a module did not immediately start its test');
      }
      const shortcut = (code, shiftKey = false) => window.dispatchEvent(new KeyboardEvent('keydown', { code, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
      const waitFor = async condition => {
        const deadline = performance.now() + 10000;
        while (!condition()) {
          if (performance.now() > deadline) throw new Error('Settings operation timed out: ' + document.getElementById('settings-trigger').getAttribute('data-save-state'));
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        await nextPaint();
      };
      if (toggleTest) {
        const checkbox = () => document.querySelector('#modules [data-module-id="' + toggleTest.id + '"] [role="checkbox"]');
        checkbox().click(); await nextPaint();
        shortcut('KeyZ'); await nextPaint();
        if (!window.moduleTests.list().some(test => test.id === toggleTest.id)) throw new Error('Undo did not restart the module');
        shortcut('KeyZ', true); await nextPaint();
        if (window.moduleTests.list().some(test => test.id === toggleTest.id)) throw new Error('Redo did not stop the module');
        shortcut('KeyZ'); await nextPaint();
      }
      const tab = name => { const tabs = [...document.querySelectorAll('[role="tab"]')]; const found = tabs.find(element => element.textContent.includes(name)); if (!found) throw new Error('Missing tab ' + name + ': ' + tabs.map(tab => JSON.stringify(tab.textContent)).join(', ')); return found; };
      const activateTab = name => {
        const element = tab(name);
        element.focus();
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      };
      await waitFor(() => document.getElementById('settings-trigger').getAttribute('data-save-state') !== 'loading');
      shortcut('KeyS');
      await waitFor(() => document.getElementById('settings-trigger').getAttribute('data-save-state') === 'saved');
      if (document.title.startsWith('*')) throw new Error('Saved title still has an asterisk');
      const historyBeforeUI = localStorage.getItem('modular-game.history');
      activateTab('Архив'); await nextPaint();
      if (document.title.startsWith('*')) throw new Error('Tab changes marked settings as dirty');
      activateTab('Рабочие'); await nextPaint();
      const category = document.querySelector('#modules button[aria-controls^="category-"]');
      category.click(); await nextPaint(); category.click(); await nextPaint();
      trigger.click(); await nextPaint(); trigger.click(); await nextPaint();
      const details = document.querySelector('[id^="details-"]');
      if (details) {
        details.click(); await nextPaint();
        const panel = document.querySelector('.info-panel:not([hidden])');
        panel.querySelector('.panel-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        await nextPaint();
        panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await nextPaint();
      }
      if (localStorage.getItem('modular-game.history') !== historyBeforeUI || document.title.startsWith('*')) throw new Error('Interface actions changed history or the dirty indicator');
      if (toggleTest) {
        shortcut('KeyZ'); await nextPaint();
        if (window.moduleTests.list().some(test => test.id === toggleTest.id)) throw new Error('UI actions intercepted module undo');
        shortcut('KeyZ', true); await nextPaint();
        if (!window.moduleTests.list().some(test => test.id === toggleTest.id) || document.title.startsWith('*')) throw new Error('Redo did not restore saved modules');
      }
      let exported;
      const createObjectURL = URL.createObjectURL;
      URL.createObjectURL = blob => { exported = blob; return createObjectURL(blob); };
      const preventDownload = event => { if (event.target instanceof HTMLAnchorElement) event.preventDefault(); };
      document.addEventListener('click', preventDownload, true);
      try {
        document.getElementById('settings-trigger').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await nextPaint();
        [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.includes('Экспортировать')).click(); await nextPaint();
      } finally { URL.createObjectURL = createObjectURL; document.removeEventListener('click', preventDownload, true); }
      if (!exported) throw new Error('Export did not produce a file');
      const exportedFile = JSON.parse(await exported.text());
      const exportedSettings = exportedFile.settings;
      if ('modular-game.camera' in exportedSettings) throw new Error('Export included the camera');
      if (Object.keys(exportedSettings).some(key => key === 'modular-game.categories' || key.startsWith('modular-game.window.')) || 'tab' in JSON.parse(exportedSettings['modular-game.module-preferences'] ?? '{}')) throw new Error('Export included interface settings');
      const statusId = enabledModules.find(module => !module.hasTest)?.id || enabledModules[0].id;
      exportedSettings['modular-game.module-preferences'] = JSON.stringify({ version: 1, statuses: { [statusId]: 'hidden' } });
      const independentCamera = JSON.stringify({ version: 1, alpha: -0.75, beta: 1.2, radius: 10, target: { x: 1, y: 2, z: -2 } });
      localStorage.setItem('modular-game.camera', independentCamera);
      if (document.title.startsWith('*')) throw new Error('Camera changes marked settings as dirty');
      // Older files may contain a camera; importing one must ignore it.
      exportedSettings['modular-game.camera'] = JSON.stringify({ version: 1, alpha: 0, beta: 1, radius: 20, target: { x: 0, y: 0, z: 0 } });
      if ('modular-game.history' in exportedSettings) throw new Error('Export included recursive history metadata');
      activateTab('Архив'); await nextPaint();
      const interfaceBeforeImport = { window: localStorage.getItem('modular-game.window.modules'), categories: localStorage.getItem('modular-game.categories') };
      exportedSettings['modular-game.categories'] = JSON.stringify({ version: 1, collapsed: ['legacy category'] });
      exportedSettings['modular-game.window.modules'] = JSON.stringify({ version: 1, open: false, position: { left: 300, top: 300 } });
      const input = document.querySelector('input[type="file"]');
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(exportedFile)], 'settings.mgeng', { type: 'application/json' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => document.getElementById('settings-trigger').getAttribute('data-save-state') === 'saved');
      if (tab('Архив').getAttribute('aria-selected') !== 'true' || localStorage.getItem('modular-game.window.modules') !== interfaceBeforeImport.window || localStorage.getItem('modular-game.categories') !== interfaceBeforeImport.categories) throw new Error('Import changed the interface');
      const savedSettings = await new Promise((resolve, reject) => {
        const request = indexedDB.open('modular-game', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('settings', 'readonly');
          const get = transaction.objectStore('settings').get('current');
          transaction.oncomplete = () => { db.close(); resolve(get.result.settings); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
      if ('modular-game.camera' in savedSettings || localStorage.getItem('modular-game.camera') !== independentCamera) throw new Error('Import included or changed the camera');
      for (const [key, value] of Object.entries(exportedSettings)) {
        if (key === 'modular-game.camera' || key === 'modular-game.categories' || key.startsWith('modular-game.window.')) continue;
        if (key === 'modular-game.module-preferences') {
          if (JSON.parse(savedSettings[key]).statuses[statusId] !== 'hidden' || JSON.parse(localStorage.getItem(key)).statuses[statusId] !== 'hidden') throw new Error('Import did not apply module statuses');
          continue;
        }
        if (savedSettings[key] !== value || localStorage.getItem(key) !== value) throw new Error('Import did not update localStorage and IndexedDB equally');
      }
      shortcut('KeyZ'); await nextPaint();
      if (JSON.parse(localStorage.getItem('modular-game.module-preferences')).statuses[statusId] === 'hidden') throw new Error('Import was not undoable');
      shortcut('KeyZ', true); await nextPaint();
      activateTab('Рабочие'); await nextPaint();
      shortcut('KeyS'); await nextPaint();
      await waitFor(() => document.getElementById('settings-trigger').getAttribute('data-save-state') === 'saved');
      const cameraBeforeTests = localStorage.getItem('modular-game.camera');
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
      const environment = { headless: ${headless}, userAgent: navigator.userAgent, width: canvas.width, height: canvas.height,
        devicePixelRatio, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown' };
      const results = await window.moduleTests.run(${JSON.stringify(ids) ?? 'undefined'}, ${seconds ?? 'undefined'});
      await nextPaint();
      if (window.moduleTests.getState().running || document.querySelector('.game-controls').inert) throw new Error('Completion did not restore controls');
      if (results.length > 1 && !document.getElementById('test-summary')) throw new Error('Results summary is missing');
      const body = document.querySelector('.test-results tbody');
      const header = document.querySelector('.test-results thead');
      const summary = document.getElementById('test-summary');
      const clones = Array.from({ length: 40 }, () => body.firstElementChild.cloneNode(true));
      try {
        body.append(...clones);
        await nextPaint();
        const headerTop = header.getBoundingClientRect().top;
        const summaryTop = summary?.getBoundingClientRect().top;
        if (body.scrollHeight <= body.clientHeight || body.clientHeight > Math.min(240, innerHeight * 0.25) + 1) throw new Error('Result rows are not height-limited');
        body.focus();
        body.scrollTop = body.scrollHeight;
        await nextPaint();
        if (body.scrollTop <= 0 || header.getBoundingClientRect().top !== headerTop || summary?.getBoundingClientRect().top !== summaryTop) throw new Error('Scrolling result rows moved the header or summary');
        const headings = [...header.querySelectorAll('th')];
        const cells = [...body.firstElementChild.children];
        if (headings.some((heading, index) => Math.abs(heading.getBoundingClientRect().left - cells[index].getBoundingClientRect().left) > 1)) throw new Error('Result columns are misaligned');
        const panel = document.querySelector('.test-panel');
        try {
          panel.style.width = '340px'; panel.style.right = 'auto';
          await nextPaint();
          const viewport = document.querySelector('.test-results [data-radix-scroll-area-viewport]');
          if (viewport.scrollWidth > viewport.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1 || panel.scrollWidth > panel.clientWidth + 1) throw new Error('Test results have horizontal overflow on a narrow panel');
        } finally { panel.style.width = ''; panel.style.right = ''; }

      } finally { clones.forEach(row => row.remove()); body.scrollTop = 0; }
      document.getElementById('close-test-results').click();
      await nextPaint();
      if (document.querySelector('.test-panel')) throw new Error('Results did not close');
      if (window.moduleTests.getState().results.length !== results.length) throw new Error('Closing the panel erased results');
      if (cameraBeforeTests && localStorage.getItem('modular-game.camera') !== cameraBeforeTests) throw new Error('Test scenarios overwrote the saved camera');
      if (!${fpsMode}) await new Promise((resolve, reject) => {
        const request = indexedDB.open('modular-game', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('settings', 'readwrite');
          const store = transaction.objectStore('settings');
          const get = store.get('current');
          get.onsuccess = () => store.put({ ...get.result, settings: { ...get.result.settings, 'modular-game.camera': 'legacy camera' } }, 'current');
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onabort = () => { db.close(); reject(transaction.error); };
        };
      });
      return { uiChecks: { moduleListScroll: true, settingsSave: true, settingsUndoRedo: true, settingsExportImport: true, play: true, playAll: true, overallProgress: tests.length > 1, summary: results.length > 1, closeResults: true, controlsLocked: true, progress: true, stop: true, controlsRestored: true }, environment, enabledModules, results };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  if (!fpsMode) {
    await send('Runtime.evaluate', { expression: 'window.__settingsReloadProbe = true' }, sessionId);
    await send('Page.reload', {}, sessionId);
    const deadline = Date.now() + 20000;
    let reloaded;
    while (Date.now() < deadline) {
      try {
        reloaded = await send('Runtime.evaluate', { expression: `Boolean(!window.__settingsReloadProbe && document.readyState === 'complete' && window.moduleTests && document.getElementById('settings-trigger')?.getAttribute('data-save-state') === 'saved')`, returnByValue: true }, sessionId);
        if (reloaded.result?.value === true) break;
      } catch { /* Navigation may temporarily destroy the execution context. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (reloaded?.result?.value !== true) throw new Error('Saved state did not survive reload');
    const historyCheck = await send('Runtime.evaluate', {
      expression: `(async () => {
        const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const shortcut = shiftKey => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
        const snapshot = localStorage.getItem('modular-game.camera');
        shortcut(false); await nextPaint();
        if (Object.values(JSON.parse(localStorage.getItem('modular-game.module-preferences')).statuses).includes('hidden')) throw new Error('Module undo history did not survive reload');
        if (JSON.parse(localStorage.getItem('modular-game.module-preferences')).tab !== 'working') throw new Error('Undo changed the interface tab');
        shortcut(true); await nextPaint();
        if (localStorage.getItem('modular-game.camera') !== snapshot) throw new Error('Undo or redo changed the independent camera');
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('modular-game', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction('settings', 'readonly');
            const get = transaction.objectStore('settings').get('current');
            transaction.oncomplete = () => {
              db.close();
              if ('modular-game.camera' in get.result.settings) reject(new Error('Legacy camera remained in IndexedDB')); else resolve();
            };
            transaction.onabort = () => { db.close(); reject(transaction.error); };
          };
        });
        return true;
      })()`, awaitPromise: true, returnByValue: true,
    }, sessionId);
    if (historyCheck.exceptionDetails) throw new Error(historyCheck.exceptionDetails.exception?.description || historyCheck.exceptionDetails.text);
    response.result.value.uiChecks.settingsReload = true;
  }
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
