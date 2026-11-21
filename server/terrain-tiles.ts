import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { pedestrianBlockers, type CollisionBox, type CollisionWorld } from '../src/modules/world/headless.ts';
import type { CharacterTerrainTile } from '../src/modules/characters/headless.ts';
import type { BuildingInteriorSource } from '../src/modules/world/headless.ts';

const SIZE = 128;
const LIMIT = 64;
export type TerrainTile = CharacterTerrainTile;
export type RoomMap = { world: string; collision: CollisionWorld; tiles: readonly string[] };

function tileKey(x: number, z: number) {
  return `${x}_${z}`;
}

export function partitionTerrain(world: CollisionWorld, interiors: readonly BuildingInteriorSource[] = []) {
  const result = new Map<string, { triangles: (readonly number[])[]; water: (readonly number[])[]; blockers: CollisionBox[]; interiors: BuildingInteriorSource[] }>();
  function distribute(bounds: CollisionWorld['bounds'], add: (tile: NonNullable<ReturnType<typeof result.get>>) => void) {
    for (let x = Math.floor((bounds.minX - 1) / SIZE); x <= Math.floor((bounds.maxX + 1) / SIZE); x++) {
      for (let z = Math.floor((bounds.minZ - 1) / SIZE); z <= Math.floor((bounds.maxZ + 1) / SIZE); z++) {
        const key = tileKey(x, z);
        let tile = result.get(key);
        if (!tile) { tile = { triangles: [], water: [], blockers: [], interiors: [] }; result.set(key, tile); }
        add(tile);
      }
    }
  }
  function add(source: readonly (readonly number[])[] | undefined, kind: 'triangles' | 'water') {
    for (const p of source ?? []) {
      distribute({
        minX:Math.min(p[0],p[3],p[6]), maxX:Math.max(p[0],p[3],p[6]),
        minZ:Math.min(p[2],p[5],p[8]), maxZ:Math.max(p[2],p[5],p[8]),
      }, tile => tile[kind].push(p));
    }
  }
  add(world.triangles, 'triangles');
  add(world.water?.triangles, 'water');
  for (const blocker of pedestrianBlockers(world)) distribute(blocker, tile => tile.blockers.push(blocker));
  for (const source of interiors) distribute(source.bounds, tile => tile.interiors.push(source));
  return result;
}

export function openRoomMap(directory: URL) {
  const manifest: RoomMap = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
  const keys = new Set(manifest.tiles);
  const cache = new Map<string, TerrainTile>();
  const empty: TerrainTile = { triangles: [], water: [], blockers: [] };
  const pending = new Set<string>();
  function remember(key: string, tile: TerrainTile) {
    cache.set(key, tile);
    if (cache.size > LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return tile;
  }
  function prefetch(x: number, z: number) {
    const margin = 24;
    for (let col = Math.floor((x - margin) / SIZE); col <= Math.floor((x + margin) / SIZE); col++) {
      for (let row = Math.floor((z - margin) / SIZE); row <= Math.floor((z + margin) / SIZE); row++) {
        const key = tileKey(col, row);
        if (!keys.has(key) || cache.has(key) || pending.has(key) || pending.size >= LIMIT) continue;
        pending.add(key);
        void readFile(new URL(key + '.json', directory), 'utf8').then(text => {
          if (!cache.has(key)) remember(key, JSON.parse(text));
        }).catch(() => {
          // A later authoritative query reports a read error. Never substitute empty collision for a missing tile.
        }).finally(() => { pending.delete(key); });
      }
    }
  }
  function terrain(x: number, z: number): TerrainTile {
    const key = tileKey(Math.floor(x / SIZE), Math.floor(z / SIZE));
    if (!keys.has(key)) return empty;
    const cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    // shortcut: local files are read on a cold miss to keep collision queries synchronous; measure cold fallback before increasing lookahead.
    const tile: TerrainTile = JSON.parse(readFileSync(new URL(key + '.json', directory), 'utf8'));
    return remember(key, tile);
  }
  return { ...manifest, terrain, prefetch, loadedTerrainTiles: () => cache.size };
}
