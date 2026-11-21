import type { Scope } from '../../core/modules.ts';
import type { CitySource } from '../world-generation/index.ts';

type Detail = NonNullable<CitySource['chunks'][number]['details']>[number];

export function createCityAssetLoader<T>(path: string, parse: (response: Response) => Promise<T>) {
  let active: { controller: AbortController; users: number; data: Promise<T> } | undefined;
  return (owner: Scope, present: (value: T) => void) => {
    if (!active) {
      const controller = new AbortController();
      const data = fetch(import.meta.env.BASE_URL + path, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parse(response);
      });
      active = { controller, users: 0, data };
    }
    const request = active;
    request.users++;
    let released = false;
    owner.onDispose(() => {
      released = true;
      request.users--;
      if (request.users === 0) {
        request.controller.abort();
        if (active === request) active = undefined;
      }
    });
    void request.data.then(value => {
      if (!released) present(value);
    }).catch(error => {
      if (!released) console.warn(`Не удалось загрузить участок ${path}`, error);
    });
  };
}

export function createDetailLoader(path: string) {
  const load = createCityAssetLoader(path, async response => {
    const details: Detail[] = await response.json();
    return new Map(details.map(detail => [detail.id, detail]));
  });
  return (id: string, owner: Scope, present: (detail: Detail) => void) => load(owner, details => {
    const detail = details.get(id);
    if (!detail) throw new Error(`Missing detail ${id}`);
    present(detail);
  });
}
