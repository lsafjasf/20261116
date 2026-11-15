// Deterministic A* on a grid. Walls use value 1. Ties are broken by insertion
// order, so given the same map+start+goal the returned path is byte-identical
// whether the path cache is enabled or not.

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(node) {
    const items = this.items;
    items.push(node);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.less(items[index], items[parent])) {
        [items[index], items[parent]] = [items[parent], items[index]];
        index = parent;
      } else {
        break;
      }
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let index = 0;
      const length = items.length;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < length && this.less(items[left], items[smallest])) {
          smallest = left;
        }
        if (right < length && this.less(items[right], items[smallest])) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        [items[index], items[smallest]] = [items[smallest], items[index]];
        index = smallest;
      }
    }
    return top;
  }
  less(a, b) {
    if (a.f !== b.f) {
      return a.f < b.f;
    }
    return a.seq < b.seq;
  }
}

class LruCache {
  constructor(capacity) {
    this.capacity = Math.max(0, capacity | 0);
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  get(key) {
    if (this.capacity === 0 || !this.map.has(key)) {
      this.misses++;
      return undefined;
    }
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    this.hits++;
    return value;
  }
  set(key, value) {
    if (this.capacity === 0) {
      return;
    }
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  get hitRate() {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }
  get stats() {
    return {
      capacity: this.capacity,
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hitRate,
    };
  }
}

export class PathService {
  constructor({ cacheCapacity = 0 } = {}) {
    this.cache = new LruCache(cacheCapacity);
    this.nodesExpanded = 0;
    this.queries = 0;
    this.candidatesPeak = 0;
  }

  findPath(map, start, goal) {
    const key = [
      map.id,
      start[0],
      start[1],
      goal[0],
      goal[1],
    ].join("|");
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.queries++;
      return cached.map((point) => [point[0], point[1]]);
    }
    const path = this.search(map, start, goal);
    this.cache.set(key, path);
    this.queries++;
    return path.map((point) => [point[0], point[1]]);
  }

  search(map, start, goal) {
    const { width, height, cells } = map;
    const indexOf = (x, y) => y * width + x;
    if (
      start[0] === goal[0] &&
      start[1] === goal[1]
    ) {
      return [start.slice()];
    }
    const gScore = new Map();
    const cameFrom = new Map();
    const open = new MinHeap();
    let sequence = 0;
    const heuristic = (x, y) =>
      Math.abs(x - goal[0]) + Math.abs(y - goal[1]);
    const startIndex = indexOf(start[0], start[1]);
    gScore.set(startIndex, 0);
    open.push({
      index: startIndex,
      x: start[0],
      y: start[1],
      f: heuristic(start[0], start[1]),
      seq: sequence++,
    });

    const neighbors = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    while (open.size > 0) {
      this.candidatesPeak = Math.max(this.candidatesPeak, open.size);
      const current = open.pop();
      if (current.x === goal[0] && current.y === goal[1]) {
        const path = [[current.x, current.y]];
        let cursor = current.index;
        while (cameFrom.has(cursor)) {
          cursor = cameFrom.get(cursor);
          path.push([cursor % width, Math.floor(cursor / width)]);
        }
        return path.reverse();
      }
      this.nodesExpanded++;
      for (const [dx, dy] of neighbors) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          continue;
        }
        if (cells[indexOf(nx, ny)] === 1) {
          continue;
        }
        const neighborIndex = indexOf(nx, ny);
        const tentative = gScore.get(current.index) + 1;
        if (
          !gScore.has(neighborIndex) ||
          tentative < gScore.get(neighborIndex)
        ) {
          gScore.set(neighborIndex, tentative);
          cameFrom.set(neighborIndex, current.index);
          open.push({
            index: neighborIndex,
            x: nx,
            y: ny,
            f: tentative + heuristic(nx, ny),
            seq: sequence++,
          });
        }
      }
    }
    return [];
  }
}
