import { Play as PlayPage } from './play.tsx';
import { Admin } from './admin.tsx';
import '@radix-ui/themes/styles.css';
import './style.css';
import { ChevronDown, ChevronRight, Info, Layers, MoreHorizontal, Play, RotateCcw } from 'lucide-react';
import { useDeferredValue, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Observable } from '@babylonjs/core/Misc/observable';
import { Badge, Box, Button, Callout, Card, Checkbox, Flex, IconButton, Text, Theme, Tooltip, Tabs, DropdownMenu } from '@radix-ui/themes';
import { createPanels, usePanels } from './core/panels.ts';
import { PanelWindow } from './core/panel-window.tsx';
import { readWindow, writeWindow } from './core/window-settings.ts';
import { modules, defaultModules } from './registry.ts';
import { formatModuleGroups, groupModules } from './core/module-categories.ts';
import { resolveModules } from './core/modules.ts';
import { readSelection, encodeSelection, STORAGE_KEY, readCollapsedCategories, CATEGORIES_STORAGE_KEY } from './core/settings.ts';
import { TestPanel } from './core/test-panel.tsx';
import type { TestState } from './core/test-runner.ts';
import { settingsHistory } from './core/settings-history.ts';
import { SettingsMenu } from './core/settings-menu.tsx';
import { createViewport } from './core/scene.ts';
import { charactersModule, clearLocalPosition } from './modules/characters/index.ts';

declare global {
  interface Window { moduleTests?: ReturnType<typeof createViewport>['tests'] }
}

import { isModuleStatus, readModulePreferences, selectModules, PREFERENCES_STORAGE_KEY, type ModuleStatus } from './core/module-preferences.ts';

const categories = groupModules(modules);

function useDisplayValue<T>(updates: Observable<T>, initial: T) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const observer = updates.add(value => setValue(value));
    return () => { updates.remove(observer); };
  }, [updates]);
  return value;
}

function FpsDisplay({ updates }: { updates: Observable<number> }) {
  const fps = useDisplayValue(updates, 0);
  return <Box className="fps"><Badge id="fps" aria-label="Частота кадров">{fps || '—'} FPS</Badge></Box>;
}

const idleTestState: TestState = { running: false, title: '', progress: 0, index: 0, total: 0, results: [] };
function TestDisplay({ updates, stop }: { updates: Observable<TestState>; stop(): void }) {
  return <TestPanel state={useDisplayValue(updates, idleTestState)} stop={stop} />;
}

function App() {
  const [testRunning, setTestRunning] = useState(false);
  const [testUpdates] = useState(() => new Observable<TestState>());
  const [fpsUpdates] = useState(() => new Observable<number>());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try { return new Set(readCollapsedCategories(localStorage.getItem(CATEGORIES_STORAGE_KEY), categories.map(category => category.title))); }
    catch { return new Set(); }
  });
  const [preferences, setPreferences] = useState(() => {
    try { return readModulePreferences(localStorage.getItem(PREFERENCES_STORAGE_KEY), modules); }
    catch { return readModulePreferences(null, modules); }
  });
  const [initial] = useState(() => {
    let raw: string | null = null;
    let status = '';
    try { raw = localStorage.getItem(STORAGE_KEY); }
    catch { status = 'Хранилище недоступно: настройки действуют до закрытия страницы.'; }
    return { ids: selectModules(modules, readSelection(raw, modules, defaultModules), preferences.statuses), status };
  });
  const [selected, setSelected] = useState(initial.ids);
  const [pendingSelection, setPendingSelection] = useState<readonly string[] | null>(null);
  const deferredSelection = useDeferredValue(pendingSelection);
  const [status, setStatus] = useState(initial.status);
  const [modulesOpen, setModulesOpen] = useState(() => readWindow('modules').open);
  const [ready, setReady] = useState(false);
  const [panels] = useState(createPanels);
  const entries = usePanels(panels);
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<ReturnType<typeof createViewport> | null>(null);
  const enabled = new Set(selectModules(modules, pendingSelection ?? selected, preferences.statuses));
  const changingModules = pendingSelection !== null;


  useEffect(() => {
    if (!canvas.current) return;
    try {
      viewport.current = createViewport(canvas.current, value => fpsUpdates.notifyObservers(Math.round(value)), panels, state => {
        setTestRunning(state.running);
        testUpdates.notifyObservers(state);
      });
      viewport.current.restart(modules, initial.ids);
      window.moduleTests = viewport.current.tests;
      setReady(true);
    } catch (error) {
      setStatus(`Ошибка 3D: ${error instanceof Error ? error.message : String(error)}`);
      setReady(viewport.current !== null);
    }
    const dispose = () => { delete window.moduleTests; viewport.current?.dispose(); viewport.current = null; };
    const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
    window.addEventListener('pagehide', onPageHide);
    return () => { window.removeEventListener('pagehide', onPageHide); dispose(); };
  }, [initial, panels, fpsUpdates, testUpdates]);

  async function runTests(ids?: readonly string[]) {
    if (changingModules) return;
    try { await viewport.current?.tests.run(ids); }
    catch (error) { setStatus(`Не удалось запустить тест: ${error instanceof Error ? error.message : String(error)}`); }
  }

  function showModules(open: boolean) {
    setModulesOpen(open);
    writeWindow('modules', { open });
  }

  function savePreferences(next: typeof preferences) {
    setPreferences(next);
    try { settingsHistory.write(PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, ...next })); }
    catch { setStatus('Браузер не разрешил сохранить статусы модулей.'); }
  }

  function syncModules(ids: readonly string[], nextPreferences = preferences) {
    const currentViewport = viewport.current;
    if (!currentViewport || testRunning) return;
    setPendingSelection(null);
    const applied = new Set(selected);
    try { settingsHistory.transaction(() => {
      const next = selectModules(modules, ids, nextPreferences.statuses);
      if (next.length !== applied.size || next.some(id => !applied.has(id))) {
        try { currentViewport.restart(modules, next); }
        catch (error) {
          try { currentViewport.restart(modules, selected); }
          catch { setReady(false); }
          throw error;
        }
      }
      setSelected(next);
      setStatus('');
      if (nextPreferences !== preferences) savePreferences(nextPreferences);
      try { settingsHistory.write(STORAGE_KEY, encodeSelection(next)); }
      catch { setStatus('Набор изменён, но браузер не разрешил сохранить настройки.'); }
    }); } catch (error) { setStatus(`Не удалось изменить набор: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const applyDeferredSelection = useEffectEvent((ids: readonly string[]) => {
    if (pendingSelection === ids && ready && !testRunning) syncModules(ids);
  });
  useEffect(() => {
    if (!deferredSelection || deferredSelection !== pendingSelection || !ready || testRunning) return;
    // Give the checkbox a paint before synchronous Babylon scene creation.
    let applyFrame: number | undefined;
    const paintFrame = requestAnimationFrame(() => {
      applyFrame = requestAnimationFrame(() => applyDeferredSelection(deferredSelection));
    });
    return () => {
      cancelAnimationFrame(paintFrame);
      if (applyFrame !== undefined) cancelAnimationFrame(applyFrame);
    };
  }, [deferredSelection, pendingSelection, ready, testRunning]);

  function resetView() {
    if (!viewport.current || testRunning) return;
    try {
      viewport.current.resetView();
      if (!selected.includes(charactersModule.id)) clearLocalPosition();
      setStatus('');
    } catch (error) { setStatus(`Не удалось сбросить положение: ${error instanceof Error ? error.message : String(error)}`); }
  }

  function restoreSettings() {
    if (!viewport.current) return;
    setPendingSelection(null);
    const nextPreferences = readModulePreferences(localStorage.getItem(PREFERENCES_STORAGE_KEY), modules);
    const ids = selectModules(modules, readSelection(localStorage.getItem(STORAGE_KEY), modules, defaultModules), nextPreferences.statuses);
    if (ids.length !== selected.length || ids.some(id => !selected.includes(id))) viewport.current.restart(modules, ids);
    setPreferences(nextPreferences);
    setSelected(ids);
  }

  function changeModuleStatus(id: string, nextStatus: ModuleStatus) {
    syncModules([...enabled].filter(enabledId => enabledId !== id || nextStatus !== 'archived'),
      { ...preferences, statuses: { ...preferences.statuses, [id]: nextStatus } });
  }

  return <Theme appearance="dark">
    <main id="game-stage" ref={host}>
      <div className="game-controls" inert={testRunning}>
      <section className="viewport"><canvas ref={canvas} aria-label="Трёхмерная сцена" tabIndex={0} /></section>
      <FpsDisplay updates={fpsUpdates} />
      <Box className="module-panel">
        <Flex justify="end" align="center" gap="2"><Button id="modules-trigger" aria-expanded={modulesOpen} aria-controls="modules-window" aria-label="Модули" size="1" variant="soft" onClick={() => showModules(!modulesOpen)}><Layers size={14} aria-hidden="true" />Модули</Button><SettingsMenu disabled={!ready || testRunning || changingModules} restore={restoreSettings} /></Flex>
        <Box id="status" role="status" aria-live="polite">
          {status && <Callout.Root size="1" mt="2"><Callout.Text>{status}</Callout.Text></Callout.Root>}
        </Box>
        <Card asChild mt="2">
          <section id="modules-window" className="module-list" hidden={!modulesOpen} aria-label="Модули">
          <Flex direction="column" gap="3">
            <Flex align="center" justify="between" gap="2">
            <Button id="test-all" size="1" variant="soft" disabled={!ready || changingModules || !modules.some(module => module.test && enabled.has(module.id))} onClick={() => { void runTests(); }}><Play size={14} aria-hidden="true" />Тест всех включённых модулей</Button>
              <Tooltip content="Вернуть персонажа и камеру в исходное положение"><IconButton id="reset" size="1" variant="ghost" aria-label="Сбросить положение персонажа и камеры" disabled={!ready} onClick={resetView}><RotateCcw size={16} aria-hidden="true" /></IconButton></Tooltip>
            </Flex>
            <Tabs.Root activationMode="manual" value={preferences.tab} onValueChange={tab => { if (isModuleStatus(tab)) savePreferences({ ...preferences, tab }); }}>
              <Tabs.List aria-label="Статус модулей">
                <Tabs.Trigger value="working">Рабочие</Tabs.Trigger>
                <Tabs.Trigger value="hidden">Скрытые</Tabs.Trigger>
                <Tabs.Trigger value="archived">Архив</Tabs.Trigger>
              </Tabs.List>
            <Tabs.Content value={preferences.tab}>
            <Text size="1" color="gray">{preferences.tab === 'hidden' ? 'Кандидаты в core · всегда включены' : preferences.tab === 'archived' ? 'Кандидаты на удаление · всегда отключены' : 'Рабочий набор модулей'}</Text>
            <Flex id="modules" role="region" aria-label="Категории и модули" tabIndex={0} direction="column" gap="3">
              {groupModules(modules.filter(module => (preferences.statuses[module.id] ?? 'working') === preferences.tab)).map((category, index) => <Flex key={category.title} direction="column" gap="3">
                <Button variant="soft" size="1" aria-expanded={!collapsed.has(category.title)} aria-controls={`category-${index}`} onClick={() => {
                  const next = new Set(collapsed);
                  if (next.has(category.title)) next.delete(category.title); else next.add(category.title);
                  setCollapsed(next);
                  try { localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify({ version: 1, collapsed: [...next] })); }
                  catch { setStatus('Браузер не разрешил сохранить состояние категорий.'); }
                }}>
                  <Flex width="100%" justify="between" align="center" gap="2">
                  <Text className="module-title" wrap="wrap">{category.title} ({category.modules.length})</Text>
                  {collapsed.has(category.title) ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  </Flex>
                </Button>
                <Flex id={`category-${index}`} className="category-modules" direction="column" gap="3" hidden={collapsed.has(category.title)}>
              {category.modules.map(module => {
                const consumers = modules.filter(other => enabled.has(other.id) && Object.values(other.requires).some(dep => dep.id === module.id));
                const working = (id: string) => !preferences.statuses[id] || preferences.statuses[id] === 'working';
                const visibleConsumers = consumers.filter(other => working(other.id));
                const dependencies = Object.values(module.requires).filter(other => working(other.id));
                const unavailable = resolveModules(modules, [module.id]).some(other => preferences.statuses[other.id] === 'archived');
                const dependencyNote = `Зависит от:\n${formatModuleGroups(dependencies)}`;
                const note = module.required ? 'Обязательный модуль' : visibleConsumers.length ? `Нужен:\n${formatModuleGroups(visibleConsumers)}` : dependencies.length ? dependencyNote : '';
                const panel = entries.find(entry => entry.id === module.id);
                return <Flex key={module.id} data-module-id={module.id} align="center" justify="between" gap="3">
                  <Flex className="module-name" align="center" gap="2">
                  <Tooltip content={<Flex direction="column">{(note || module.title).split('\n').map((line, index) => <Text key={index}>{line}</Text>)}</Flex>}>
                  <Text as="label" size="2" tabIndex={0}>
                    <Flex align="center" gap="2">
                      <Checkbox checked={enabled.has(module.id)} disabled={!ready || preferences.tab !== 'working' || !!module.required || consumers.length > 0 || unavailable}
                        onCheckedChange={checked => {
                          setPendingSelection(previous => {
                            const current = previous ?? selected;
                            const next = checked === true ? [...current, module.id] : current.filter(id => id !== module.id);
                            return selectModules(modules, next, preferences.statuses);
                          });
                        }} />
                      <span className="module-title">{module.title}</span>
                    </Flex>
                  </Text>
                  </Tooltip>
                  </Flex>
                  <Flex className="module-actions" align="center" gap="2">
                  {module.test && <Tooltip content={`Тест: ${module.title}`}><IconButton id={`test-${module.id}`} size="1" variant="ghost" aria-label={`Запустить тест: ${module.title}`} disabled={!ready || changingModules || !enabled.has(module.id)} onClick={() => { void runTests([module.id]); }}><Play size={16} aria-hidden="true" /></IconButton></Tooltip>}
                  {panel && <Tooltip content={`Детали: ${module.title}`}><IconButton id={`details-${module.id}`} size="1" variant="ghost" aria-label={`Детали: ${module.title}`}
                    aria-expanded={panel.open} onClick={() => panels.toggle(module.id)}><Info size={16} aria-hidden="true" /></IconButton></Tooltip>}
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger><IconButton size="1" variant="ghost" aria-label={`Статус: ${module.title}`}><MoreHorizontal size={16} aria-hidden="true" /></IconButton></DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                      {preferences.tab === 'working' ? <>
                        <DropdownMenu.Item disabled={!ready || unavailable} onSelect={() => changeModuleStatus(module.id, 'hidden')}>Скрыть</DropdownMenu.Item>
                        <DropdownMenu.Item disabled={!ready || !!module.required || consumers.length > 0} onSelect={() => changeModuleStatus(module.id, 'archived')}>Архивировать</DropdownMenu.Item>
                      </> : <DropdownMenu.Item disabled={!ready} onSelect={() => changeModuleStatus(module.id, 'working')}>{preferences.tab === 'archived' ? 'Разархивировать' : 'Вернуть в рабочие'}</DropdownMenu.Item>}
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
                  </Flex>
                </Flex>;
              })}
                </Flex>
              </Flex>)}
            </Flex>
            </Tabs.Content>
            </Tabs.Root>
          </Flex>
          </section>
        </Card>
      </Box>
      {entries.map(panel => panel.overlay
        ? <aside key={panel.id} id={`${panel.id}-window`} className="scene-overlay" aria-label={panel.title} hidden={!panel.open}>
            {panel.open && panel.content}
          </aside>
        : <PanelWindow key={panel.id} panel={panel} panels={panels} host={host} />)}
      </div>
      <TestDisplay updates={testUpdates} stop={() => viewport.current?.tests.stop()} />
    </main>
  </Theme>;
}

const root = createRoot(document.querySelector('#app')!);
root.render(/^\/admin\/?$/.test(location.pathname) ? <Admin /> : /^\/play\/?$/.test(location.pathname) ? <PlayPage /> : <App />);
import.meta.hot?.dispose(() => root.unmount());
