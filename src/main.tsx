import '@radix-ui/themes/styles.css';
import './style.css';
import { Check, ChevronDown, ChevronRight, Info, Layers, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge, Box, Button, Callout, Card, Checkbox, Flex, IconButton, Text, Theme, Tooltip } from '@radix-ui/themes';
import { createPanels, usePanels } from './core/panels.ts';
import { PanelWindow } from './core/panel-window.tsx';
import { readWindow, writeWindow } from './core/window-settings.ts';
import { modules, defaultModules } from './registry.ts';
import { formatModuleGroups, groupModules } from './core/module-categories.ts';
import { resolveModules } from './core/modules.ts';
import { readSelection, encodeSelection, STORAGE_KEY, readCollapsedCategories, CATEGORIES_STORAGE_KEY } from './core/settings.ts';
import { createViewport } from './core/scene.ts';

const categories = groupModules(modules);

function App() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try { return new Set(readCollapsedCategories(localStorage.getItem(CATEGORIES_STORAGE_KEY), categories.map(category => category.title))); }
    catch { return new Set(); }
  });
  const [initial] = useState(() => {
    let raw: string | null = null;
    let status = '';
    try { raw = localStorage.getItem(STORAGE_KEY); }
    catch { status = 'Хранилище недоступно: настройки действуют до закрытия страницы.'; }
    return { ids: readSelection(raw, modules, defaultModules), status };
  });
  const [selected, setSelected] = useState(initial.ids);
  const [status, setStatus] = useState(initial.status);
  const [applied, setApplied] = useState(initial.ids);
  const [modulesOpen, setModulesOpen] = useState(() => readWindow('modules').open);
  const [fps, setFps] = useState(0);
  const [ready, setReady] = useState(false);
  const [panels] = useState(createPanels);
  const entries = usePanels(panels);
  const host = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<ReturnType<typeof createViewport> | null>(null);
  const enabled = new Set(resolveModules(modules, selected).map(module => module.id));

  const dirty = enabled.size !== applied.length || applied.some(id => !enabled.has(id));

  useEffect(() => {
    if (!canvas.current) return;
    try {
      viewport.current = createViewport(canvas.current, value => setFps(Math.round(value)), panels);
      viewport.current.restart(modules, initial.ids);
      setReady(true);
    } catch (error) {
      setStatus(`Ошибка 3D: ${error instanceof Error ? error.message : String(error)}`);
      setReady(viewport.current !== null);
    }
    const dispose = () => { viewport.current?.dispose(); viewport.current = null; };
    const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
    window.addEventListener('pagehide', onPageHide);
    return () => { window.removeEventListener('pagehide', onPageHide); dispose(); };
  }, [initial, panels]);

  function showModules(open: boolean) {
    setModulesOpen(open);
    writeWindow('modules', { open });
  }

  function apply() {
    if (!viewport.current) return;
    try { viewport.current.restart(modules, [...enabled]); }
    catch (error) { setStatus(`Не удалось запустить сцену: ${error instanceof Error ? error.message : String(error)}`); return; }
    setApplied([...enabled]);
    try { localStorage.setItem(STORAGE_KEY, encodeSelection([...enabled])); setStatus(''); }
    catch { setStatus('Набор применён, но браузер не разрешил сохранить настройки.'); }
  }

  return <Theme appearance="dark">
    <main id="game-stage" ref={host}>
      <section className="viewport"><canvas ref={canvas} aria-label="Трёхмерная сцена" tabIndex={0} /></section>
      <Box className="fps"><Badge id="fps" aria-label="Частота кадров">{fps || '—'} FPS</Badge></Box>
      <Box className="module-panel">
        <Flex justify="end"><Button id="modules-trigger" aria-expanded={modulesOpen} aria-controls="modules-window" aria-label={dirty ? 'Модули: есть неприменённые изменения' : 'Модули'} size="1" variant="soft" onClick={() => showModules(!modulesOpen)}><Layers size={14} aria-hidden="true" />Модули{dirty && ' •'}</Button></Flex>
        <Box id="status" role="status" aria-live="polite">
          {status && <Callout.Root size="1" mt="2"><Callout.Text>{status}</Callout.Text></Callout.Root>}
        </Box>
        <Card asChild mt="2">
          <section id="modules-window" className="module-list" hidden={!modulesOpen} aria-label="Модули">
          <Flex direction="column" gap="3">
            <Flex id="modules" direction="column" gap="3">
              {categories.map((category, index) => <Flex key={category.title} direction="column" gap="3">
                <Button variant="soft" size="1" aria-expanded={!collapsed.has(category.title)} aria-controls={`category-${index}`} onClick={() => {
                  const next = new Set(collapsed);
                  if (next.has(category.title)) next.delete(category.title); else next.add(category.title);
                  setCollapsed(next);
                  try { localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify({ version: 1, collapsed: [...next] })); }
                  catch { setStatus('Браузер не разрешил сохранить состояние категорий.'); }
                }}>
                  <Flex width="100%" justify="between" align="center" gap="2">
                  <Text>{category.title} ({category.modules.length})</Text>
                  {collapsed.has(category.title) ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                  </Flex>
                </Button>
                <Flex id={`category-${index}`} className="category-modules" direction="column" gap="3" hidden={collapsed.has(category.title)}>
              {category.modules.map(module => {
                const consumers = modules.filter(other => enabled.has(other.id) && Object.values(other.requires).some(dep => dep.id === module.id));
                const dependencies = Object.values(module.requires);
                const dependencyNote = `Зависит от:\n${formatModuleGroups(dependencies)}`;
                const note = module.required ? 'Обязательный модуль' : consumers.length ? `Нужен:\n${formatModuleGroups(consumers)}` : dependencies.length ? dependencyNote : '';
                const panel = entries.find(entry => entry.id === module.id);
                return <Flex key={module.id} align="center" justify="between" gap="3">
                  <Flex align="center" gap="2">
                  <Tooltip content={<Flex direction="column">{(note || module.title).split('\n').map((line, index) => <Text key={index}>{line}</Text>)}</Flex>}>
                  <Text as="label" size="2" tabIndex={0}>
                    <Flex align="center" gap="2">
                      <Checkbox checked={enabled.has(module.id)} disabled={!!module.required || consumers.length > 0}
                        onCheckedChange={checked => {
                          setSelected(checked === true ? [...enabled, module.id] : [...enabled].filter(id => id !== module.id));
                        }} />
                      {module.title}
                    </Flex>
                  </Text>
                  </Tooltip>
                  </Flex>
                  {panel && <Tooltip content={`Детали: ${formatModuleGroups([module])}`}><IconButton id={`details-${module.id}`} size="1" variant="ghost" aria-label={`Детали: ${formatModuleGroups([module])}`}
                    aria-expanded={panel.open} onClick={() => panels.toggle(module.id)}><Info size={16} aria-hidden="true" /></IconButton></Tooltip>}
                </Flex>;
              })}
                </Flex>
              </Flex>)}
            </Flex>
            <Flex gap="2" align="center" justify="between">
              <Button id="apply" size="1" disabled={!ready || (!dirty && !status)} onClick={apply}><Check size={16} aria-hidden="true" />Применить</Button>
              <Tooltip content="Вернуть стартовый набор"><IconButton id="reset" size="1" variant="ghost" aria-label="Сбросить набор" onClick={() => setSelected([...defaultModules])}><RotateCcw size={16} aria-hidden="true" /></IconButton></Tooltip>
            </Flex>
          </Flex>
          </section>
        </Card>
      </Box>
      {entries.map(panel => <PanelWindow key={panel.id} panel={panel} panels={panels} host={host} />)}
    </main>
  </Theme>;
}

const root = createRoot(document.querySelector('#app')!);
root.render(<App />);
import.meta.hot?.dispose(() => root.unmount());
