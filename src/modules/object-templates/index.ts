import { defineModule } from '../../core/context.ts';
import type { Scope } from '../../core/modules.ts';
import { geometryModule, type GeometryPart } from '../geometry/index.ts';

// shortcut: only numeric parameters, extend when a content template needs another type.
export interface NumberParameter {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}
export interface TemplateLevel {
  readonly distance: number;
  readonly parts: readonly GeometryPart[];
}
export interface TemplateContent {
  readonly levels: readonly TemplateLevel[];
  readonly hideDistance: number;
}
export interface ObjectTemplate {
  readonly id: string;
  readonly version: number;
  readonly parameters: Readonly<Record<string, NumberParameter>>;
  build(parameters: Readonly<Record<string, number>>): TemplateContent;
}
export interface ResolvedTemplate extends TemplateContent {
  readonly templateId: string;
  readonly version: number;
  readonly parameters: Readonly<Record<string, number>>;
}

function copyPart(part: GeometryPart): GeometryPart {
  return {
    surface: part.surface, size: [...part.size],
    ...(part.position ? { position: [...part.position] } : {}),
    ...(part.rotation ? { rotation: [...part.rotation] } : {}),
  };
}

export const objectTemplatesModule = defineModule({
  id: 'object-templates', category: 'Рендеринг', title: 'Шаблоны объектов', requires: { geometry: geometryModule },
  setup({ deps, scope }) {
    const catalog = new Map<string, ObjectTemplate>();
    let stopped = false;
    scope.onDispose(() => { stopped = true; catalog.clear(); });
    function ensureRunning() {
      if (stopped) throw new Error('Модуль шаблонов остановлен');
    }
    function resolveDefinition(template: ObjectTemplate, overrides: Readonly<Record<string, number>>): ResolvedTemplate {
      for (const key of Object.keys(overrides)) {
        if (!Object.hasOwn(template.parameters, key)) throw new Error(`Неизвестный параметр: ${key}`);
      }
      const parameters = Object.freeze(Object.fromEntries(Object.entries(template.parameters).map(([key, rule]) => {
        const value = Object.hasOwn(overrides, key) ? overrides[key] : rule.default;
        if (!Number.isFinite(value) || value < rule.min || value > rule.max) throw new Error(`Недопустимое значение параметра: ${key}`);
        return [key, value];
      })));
      const content = template.build(parameters);
      if (!Number.isFinite(content.hideDistance) || content.hideDistance <= 0 || !content.levels.length) {
        throw new Error('Нужны уровни детализации и положительная конечная дальность исчезновения');
      }
      let previous = -1;
      const levels = content.levels.map((level, index) => {
        if (!Number.isFinite(level.distance) || level.distance <= previous || (index === 0 && level.distance !== 0) || level.distance >= content.hideDistance) {
          throw new Error('Пороги LOD должны начинаться с нуля, возрастать и быть меньше дальности исчезновения');
        }
        previous = level.distance;
        deps.geometry.validateParts(level.parts);
        return { distance: level.distance, parts: level.parts.map(copyPart) };
      });
      return { templateId: template.id, version: template.version, parameters, hideDistance: content.hideDistance, levels };
    }
    function register(definition: ObjectTemplate, owner: Scope) {
      ensureRunning();
      if (!definition.id.trim() || !Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error('Нужны ID и положительная целая версия шаблона');
      if (catalog.has(definition.id)) throw new Error(`Шаблон уже зарегистрирован: ${definition.id}`);
      const parameters = Object.fromEntries(Object.entries(definition.parameters).map(([key, rule]) => {
        if (!key.trim() || ![rule.default, rule.min, rule.max].every(Number.isFinite) || rule.min > rule.max || rule.default < rule.min || rule.default > rule.max) {
          throw new Error(`Некорректное описание параметра: ${key}`);
        }
        return [key, Object.freeze({ default: rule.default, min: rule.min, max: rule.max })];
      }));
      const template: ObjectTemplate = Object.freeze({ id: definition.id, version: definition.version, parameters: Object.freeze(parameters), build: definition.build });
      resolveDefinition(template, {});
      catalog.set(template.id, template);
      owner.onDispose(() => { if (catalog.get(template.id) === template) catalog.delete(template.id); });
    }
    function resolve(templateId: string, parameters: Readonly<Record<string, number>> = {}) {
      ensureRunning();
      const template = catalog.get(templateId);
      if (!template) throw new Error(`Неизвестный шаблон: ${templateId}`);
      return resolveDefinition(template, parameters);
    }
    function createModel(templateId: string, name: string, parameters: Readonly<Record<string, number>>, owner: Scope, level = 0) {
      const template = resolve(templateId, parameters);
      if (!Number.isInteger(level) || level < 0 || level >= template.levels.length) throw new Error('Неизвестный уровень детализации');
      return { template, model: deps.geometry.createModel(name, template.levels[level].parts, owner) };
    }
    return {
      register, resolve, createModel,
      list() { ensureRunning(); return Array.from(catalog.values(), ({ id, version }) => ({ id, version })); },
    };
  },
});
