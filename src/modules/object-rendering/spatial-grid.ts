const CELL_SIZE = 128;
const MAX_CELLS_PER_OBJECT = 256;
interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }

export class SpatialGrid<T> {
  private readonly cells = new Map<string, Set<T>>();
  private readonly memberships = new Map<T, readonly string[] | null>();
  private readonly oversized = new Set<T>();

  insert(object: T, bounds: Bounds, distance: number) {
    this.remove(object);
    const minX = Math.floor((bounds.minX - distance) / CELL_SIZE);
    const maxX = Math.floor((bounds.maxX + distance) / CELL_SIZE);
    const minZ = Math.floor((bounds.minZ - distance) / CELL_SIZE);
    const maxZ = Math.floor((bounds.maxZ + distance) / CELL_SIZE);
    // shortcut: oversized objects are always candidates, revisit if their count becomes significant.
    if (![minX, maxX, minZ, maxZ].every(Number.isSafeInteger) || (maxX - minX + 1) * (maxZ - minZ + 1) > MAX_CELLS_PER_OBJECT) {
      this.oversized.add(object);
      this.memberships.set(object, null);
      return;
    }
    const keys: string[] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        const key = `${x}/${z}`;
        const cell = this.cells.get(key) ?? new Set<T>();
        cell.add(object);
        this.cells.set(key, cell);
        keys.push(key);
      }
    }
    this.memberships.set(object, keys);
  }

  remove(object: T) {
    for (const key of this.memberships.get(object) ?? []) {
      const cell = this.cells.get(key);
      cell?.delete(object);
      if (!cell?.size) this.cells.delete(key);
    }
    this.oversized.delete(object);
    this.memberships.delete(object);
  }

  *query(x: number, z: number) {
    yield* this.oversized;
    const cell = this.cells.get(`${Math.floor(x / CELL_SIZE)}/${Math.floor(z / CELL_SIZE)}`);
    if (cell) yield* cell;
  }

  get size() { return this.cells.size; }
  clear() { this.cells.clear(); this.memberships.clear(); this.oversized.clear(); }
}
