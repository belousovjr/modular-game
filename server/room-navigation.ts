import { setImmediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { createNpcNavigation, createNpcNavigationAsync, type NavigationSource } from '../src/modules/npcs/headless.ts';

function source(directory: URL, worldId: string) {
  const file = new URL('npc.json', directory);
  const data: {
    city: Omit<NavigationSource, 'chunks'>;
    world: Parameters<typeof createNpcNavigation>[1];
    interiors: Parameters<typeof createNpcNavigation>[2];
    chunkCount: number;
  } = JSON.parse(readFileSync(file, 'utf8'));
  const { city, world, interiors, chunkCount } = data;
  if (`${city.id}/${city.version}` !== worldId) {
    throw new Error('Room NPC map is out of date. Run npm run prepare:room.');
  }
  function* chunks(): NavigationSource['chunks'] {
    for (let index = 0; index < chunkCount; index++) {
      yield JSON.parse(readFileSync(new URL(`npc-${index}.json`, directory), 'utf8'));
    }
  }
  return [{ ...city, chunks: chunks() }, world, interiors] as const;
}

export function loadRoomNavigation(directory:URL,worldId:string){return createNpcNavigation(...source(directory,worldId));}
export function loadRoomNavigationAsync(directory:URL,worldId:string){return createNpcNavigationAsync(...source(directory,worldId),setImmediate);}
