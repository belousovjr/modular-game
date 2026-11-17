import { defineModule } from '../../core/context.ts';
import type { Scope } from '../../core/modules.ts';
import { createScope } from '../../core/scope.ts';
import { objectRenderingModule } from '../object-rendering/index.ts';

export interface SectionBounds { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number }

export const worldStreamingModule = defineModule({
  id: 'world-streaming', title: 'Загрузка участков', category: 'Окружение',
  requires: { rendering: objectRenderingModule },
  setup({ core, deps, scope }) {
    type Section = { bounds: SectionBounds; load(owner: Scope): void; loadDistanceSq:number; unloadDistanceSq:number; unloadDelayMs:number; outsideMs?:number; owner?: ReturnType<typeof createScope> };
    const sections = new Map<string, Section>();
    let stopped = false;
    let loaded = 0;
    let loads = 0;
    let unloads = 0;
    scope.onDispose(() => {
      stopped = true;
      const errors: unknown[] = [];
      for (const section of sections.values()) {
        try { section.owner?.dispose(); } catch (error) { errors.push(error); }
      }
      sections.clear(); loaded = 0;
      if (errors.length) throw new AggregateError(errors, 'Ошибка выгрузки участков');
    });
    function ensureRunning() { if (stopped) throw new Error('Загрузка участков остановлена'); }
    const observer = core.scene.onBeforeRenderObservable.add(() => {
      const point = deps.rendering.getDistanceOrigin();
      const pending: { section: Section; distance: number }[] = [];
      for (const section of sections.values()) {
        const b = section.bounds;
        const dx=point?Math.max(b.minX-point.x,0,point.x-b.maxX):Infinity;
        const dz=point?Math.max(b.minZ-point.z,0,point.z-b.maxZ):Infinity;
        const distance=dx*dx+dz*dz;
        if (section.owner && distance > section.unloadDistanceSq) {
          section.outsideMs=section.outsideMs===undefined?0:section.outsideMs+core.scene.getEngine().getDeltaTime();
          if(!point||section.outsideMs>=section.unloadDelayMs){const owner = section.owner;section.owner = undefined; loaded--; unloads++;owner.dispose();}
        }else section.outsideMs=undefined;
        if (!section.owner && distance <= section.loadDistanceSq) pending.push({ section, distance });
      }
      pending.sort((a, b) => a.distance - b.distance);
      // shortcut: two synchronous sections per frame; revisit with measured stalls or external assets.
      for (const { section } of pending.slice(0, 2)) {
        const owner = createScope();
        try { section.load(owner); }
        catch (error) {
          try { owner.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Ошибка загрузки и очистки участка'); }
          throw error;
        }
        section.owner = owner; loaded++; loads++;
      }
    }, -1, true);
    scope.onDispose(() => core.scene.onBeforeRenderObservable.remove(observer));
    return {
      registerSection(id: string, bounds: SectionBounds, load: (owner: Scope) => void, owner: Scope, distances:{load:number;unload:number;unloadDelayMs?:number}={load:192,unload:256}) {
        ensureRunning();
        if(!Number.isFinite(distances.load)||!Number.isFinite(distances.unload)||distances.load<0||distances.unload<=distances.load||distances.unload>4000)throw new Error('Invalid streaming distances');
        const unloadDelayMs=distances.unloadDelayMs??0;if(!Number.isFinite(unloadDelayMs)||unloadDelayMs<0||unloadDelayMs>1000)throw new Error('Invalid unload delay');
        if (!id.trim() || sections.has(id) || ![bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ].every(Number.isFinite) || bounds.minX >= bounds.maxX || bounds.minZ >= bounds.maxZ) throw new Error('Некорректный участок');
        const section: Section = { bounds: { ...bounds }, load,loadDistanceSq:distances.load**2,unloadDistanceSq:distances.unload**2,unloadDelayMs };
        sections.set(id, section);
        owner.onDispose(() => {
          if (!sections.delete(id)) return;
          const lifetime = section.owner;
          section.owner = undefined;
          if (lifetime) { loaded--; unloads++; lifetime.dispose(); }
        });
      },
      getStats() { ensureRunning(); return { sections: sections.size, loaded, loads, unloads }; },
    };
  },
});
