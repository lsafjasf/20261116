import { boundsOverlap, pairKey } from "./geometry.js";

export class SpatialGrid {
  constructor(cellSize = 72) {
    this.cellSize = Math.max(1, cellSize);
    this.cells = new Map();
    this.entries = new Map();
    this.nodeCount = 0;
    this.maxCellSize = 0;
    this.reusedCells = 0;
    this.replacedCells = 0;
    this.lastUpdate = { reused: 0, removed: 0, added: 0 };
  }

  key(column, row) {
    return `${column},${row}`;
  }

  cellKeysFor(bounds) {
    const columnStart = Math.floor(bounds.minX / this.cellSize);
    const columnEnd = Math.floor(bounds.maxX / this.cellSize);
    const rowStart = Math.floor(bounds.minY / this.cellSize);
    const rowEnd = Math.floor(bounds.maxY / this.cellSize);
    const keys = [];
    for (let column = columnStart; column <= columnEnd; column += 1) {
      for (let row = rowStart; row <= rowEnd; row += 1) {
        keys.push(this.key(column, row));
      }
    }
    return keys;
  }

  addRaw(id, bounds, keys) {
    const keySet = new Set(keys);
    for (const cellKey of keySet) {
      let cell = this.cells.get(cellKey);
      if (!cell) {
        cell = new Set();
        this.cells.set(cellKey, cell);
      }
      cell.add(id);
      this.nodeCount += 1;
      this.maxCellSize = Math.max(this.maxCellSize, cell.size);
    }
    this.entries.set(id, { bounds: { ...bounds }, keys: keySet });
  }

  insert(object, bounds) {
    this.remove(object.id);
    const keys = this.cellKeysFor(bounds);
    this.addRaw(object.id, bounds, keys);
    this.lastUpdate = { reused: 0, removed: 0, added: keys.length };
    return this.lastUpdate;
  }

  update(object, bounds) {
    const previous = this.entries.get(object.id);
    const keys = this.cellKeysFor(bounds);
    const nextKeys = new Set(keys);
    let reused = 0;
    if (previous) {
      for (const cellKey of nextKeys) {
        if (previous.keys.has(cellKey)) reused += 1;
      }
      for (const cellKey of previous.keys) {
        const cell = this.cells.get(cellKey);
        if (!cell) continue;
        cell.delete(object.id);
        this.nodeCount -= 1;
        if (cell.size === 0) this.cells.delete(cellKey);
      }
    }

    this.addRaw(object.id, bounds, keys);
    this.reusedCells += reused;
    this.replacedCells += keys.length;
    this.lastUpdate = {
      reused,
      removed: previous ? previous.keys.size : 0,
      added: keys.length
    };
    return this.lastUpdate;
  }

  remove(id) {
    const previous = this.entries.get(id);
    if (!previous) return { reused: 0, removed: 0, added: 0 };
    for (const cellKey of previous.keys) {
      const cell = this.cells.get(cellKey);
      if (!cell) continue;
      cell.delete(id);
      this.nodeCount -= 1;
      if (cell.size === 0) this.cells.delete(cellKey);
    }
    this.entries.delete(id);
    this.lastUpdate = { reused: 0, removed: previous.keys.size, added: 0 };
    return this.lastUpdate;
  }

  clear() {
    this.cells.clear();
    this.entries.clear();
    this.nodeCount = 0;
    this.maxCellSize = 0;
    this.reusedCells = 0;
    this.replacedCells = 0;
    this.lastUpdate = { reused: 0, removed: 0, added: 0 };
  }

  rebuild(objects) {
    this.clear();
    for (const object of objects) this.insert(object, object.bounds);
  }

  candidatePairs() {
    const seen = new Set();
    const pairs = [];
    let cellsVisited = 0;
    let sharedCellTests = 0;

    for (const ids of this.cells.values()) {
      cellsVisited += 1;
      if (ids.size < 2) continue;
      const members = Array.from(ids);
      for (let left = 0; left < members.length; left += 1) {
        const idA = members[left];
        const boundsA = this.entries.get(idA).bounds;
        for (let right = left + 1; right < members.length; right += 1) {
          const idB = members[right];
          sharedCellTests += 1;
          const key = pairKey(idA, idB);
          if (seen.has(key)) continue;
          seen.add(key);
          if (boundsOverlap(boundsA, this.entries.get(idB).bounds, 1e-9)) {
            pairs.push(idA < idB ? [idA, idB] : [idB, idA]);
          }
        }
      }
    }

    pairs.sort((left, right) => pairKey(left[0], left[1]) - pairKey(right[0], right[1]));
    return {
      pairs,
      cellsVisited,
      sharedCellTests,
      uniquePairs: seen.size,
      occupiedCells: this.cells.size,
      nodeCount: this.nodeCount,
      maxCellSize: this.maxCellSize
    };
  }

  reuseRatio() {
    return this.replacedCells === 0 ? 1 : this.reusedCells / this.replacedCells;
  }
}
