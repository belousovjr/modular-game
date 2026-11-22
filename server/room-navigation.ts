import { readFileSync } from 'node:fs';
import { createNpcNavigation, type NavigationSource } from '../src/modules/npcs/headless.ts';

export function loadRoomNavigation(directory: URL, worldId: string) {
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
  return createNpcNavigation({ ...city, chunks: chunks() }, world, interiors);
}
