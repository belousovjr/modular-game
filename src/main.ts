import './style.css';
import { modules, defaultModules } from './registry.ts';
import { resolveModules } from './core/modules.ts';
import { readSelection, encodeSelection, STORAGE_KEY } from './core/settings.ts';
import { createViewport } from './core/scene.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header><div><span class="eyebrow">MODULAR GAME / 0.1</span><h1>Лаборатория мира</h1></div><span class="badge">LOCAL AUTHORITY</span></header>
  <main><section class="viewport"><canvas aria-label="Трёхмерная сцена" tabindex="0"></canvas><div class="scene-label">BABYLON.JS <span>•</span> Пустой мир, открытые возможности</div></section>
  <aside><div class="eyebrow">РАБОЧЕЕ ПРОСТРАНСТВО</div><h2>Режим</h2><div class="modes"><button id="edit" type="button">Разработка</button><button id="play" type="button">Игра</button></div><p>Переключение создаёт новую сцену. Игровое состояние не изменяет редакторское.</p><h2>Модули</h2><div id="modules"></div><button id="apply" class="primary" type="button">Применить и перезапустить</button><button id="reset" type="button">Сбросить набор</button><p>Выбор сохраняется только в этом браузере. Зависимости включаются автоматически.</p><div class="telemetry"><span id="mode-label"></span><output id="clock"></output></div><p id="status" role="status" aria-live="polite"></p></aside></main>
  <footer>Мышь — вращение · Колесо — масштаб <span>60 Hz simulation / independent rendering</span></footer>`;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
let raw: string | null = null;
try { raw = localStorage.getItem(STORAGE_KEY); } catch { status.textContent = 'Хранилище недоступно: настройки действуют до закрытия страницы.'; }
let selected = readSelection(raw, modules, defaultModules);
let active = [...selected];
let mode: 'edit' | 'play' = 'edit';
const list = document.querySelector<HTMLDivElement>('#modules')!;
function renderModules() {
  list.replaceChildren();
  const enabled = new Set(resolveModules(modules, selected).map(module => module.id));
  selected = [...enabled];
  for (const module of modules) {
    const consumers = modules.filter(other => enabled.has(other.id) && Object.values(other.requires).some(dep => dep.id === module.id));
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled.has(module.id);
    checkbox.disabled = !!module.required || consumers.length > 0;
    const text = document.createElement('span');
    text.textContent = module.title;
    const note = document.createElement('small');
    note.textContent = consumers.length ? `Нужен: ${consumers.map(item => item.title).join(', ')}` : Object.values(module.requires).length ? `Зависит от: ${Object.values(module.requires).map(dep => dep.title).join(', ')}` : 'Без зависимостей';
    text.append(note);
    checkbox.addEventListener('change', () => {
      selected = checkbox.checked ? [...selected, module.id] : selected.filter(id => id !== module.id);
      renderModules();
      status.textContent = 'Есть изменения. Нажмите «Применить».';
    });
    label.append(checkbox, text);
    list.append(label);
  }
}
try {
  const clock = document.querySelector<HTMLOutputElement>('#clock')!;
  const viewport = createViewport(document.querySelector('canvas')!, snapshot => {
    clock.value = `${snapshot.seconds.toFixed(1)} s · tick ${snapshot.tick}${snapshot.pendingTicks ? ` · догоняем: ${snapshot.pendingTicks}` : ''}`;
  });
  function restart(nextMode = mode, ids = active) {
    try {
      viewport.restart(modules, ids, nextMode);
      mode = nextMode;
      document.querySelector('#mode-label')!.textContent = mode === 'play' ? 'Симуляция запущена' : 'Симуляция остановлена';
      for (const name of ['edit', 'play']) document.querySelector(`#${name}`)!.setAttribute('aria-pressed', String(name === mode));
      return true;
    } catch (error) { status.textContent = `Не удалось запустить сцену: ${error instanceof Error ? error.message : String(error)}`; return false; }
  }
  document.querySelector('#apply')!.addEventListener('click', () => {
    if (!restart(mode, selected)) return;
    active = [...selected];
    try { localStorage.setItem(STORAGE_KEY, encodeSelection(active)); status.textContent = 'Набор применён и сохранён.'; }
    catch { status.textContent = 'Набор применён, но браузер не разрешил сохранить настройки.'; }
  });
  document.querySelector('#reset')!.addEventListener('click', () => { selected = [...defaultModules]; renderModules(); status.textContent = 'Выбран стартовый набор. Нажмите «Применить».'; });
  document.querySelector('#edit')!.addEventListener('click', () => restart('edit'));
  document.querySelector('#play')!.addEventListener('click', () => restart('play'));
  const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) viewport.dispose(); };
  window.addEventListener('pagehide', onPageHide);
  import.meta.hot?.dispose(() => { window.removeEventListener('pagehide', onPageHide); viewport.dispose(); });
  restart();
} catch (error) { status.textContent = `Ошибка 3D: ${error instanceof Error ? error.message : String(error)}`; }
renderModules();
