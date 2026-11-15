import { contactDigest, contactKey, narrowPhase, pairKey } from "./geometry.js";
import { SpatialGrid } from "./spatial-grid.js";

function collectContacts(objects, pairs) {
  const contacts = [];
  const byId = new Map(objects.map((object) => [object.id, object]));
  for (const [idA, idB] of pairs) {
    const contact = narrowPhase(byId.get(idA), byId.get(idB));
    if (contact) contacts.push(contact);
  }
  contacts.sort((left, right) => pairKey(left.a, left.b) - pairKey(right.a, right.b));
  return contacts;
}

export function detectBruteForce(objects) {
  const pairs = [];
  for (let left = 0; left < objects.length; left += 1) {
    for (let right = left + 1; right < objects.length; right += 1) {
      pairs.push([objects[left].id, objects[right].id]);
    }
  }
  const contacts = collectContacts(objects, pairs);
  return {
    strategy: "brute",
    candidatePairs: pairs.length,
    narrowPairs: pairs.length,
    contacts,
    digest: contactDigest(contacts),
    occupiedCells: 0,
    nodeCount: 0,
    cellsVisited: 0
  };
}

export function detectSpatialGrid(objects, grid) {
  const broad = grid.candidatePairs();
  const contacts = collectContacts(objects, broad.pairs);
  return {
    strategy: "grid",
    candidatePairs: broad.pairs.length,
    narrowPairs: broad.pairs.length,
    contacts,
    digest: contactDigest(contacts),
    occupiedCells: broad.occupiedCells,
    nodeCount: broad.nodeCount,
    cellsVisited: broad.cellsVisited,
    sharedCellTests: broad.sharedCellTests
  };
}

export class CollisionScene {
  constructor(objects, cellSize = 72) {
    this.objects = objects;
    this.byId = new Map();
    for (const object of objects) {
      object.bounds = objectBounds(object);
      this.byId.set(object.id, object);
    }
    this.grid = new SpatialGrid(cellSize);
    this.grid.rebuild(objects);
  }

  setCellSize(cellSize) {
    this.grid = new SpatialGrid(cellSize);
    this.grid.rebuild(this.objects);
  }

  update(id) {
    const object = this.byId.get(id);
    if (!object) return null;
    object.bounds = objectBounds(object);
    return this.grid.update(object, object.bounds);
  }

  remove(id) {
    this.grid.remove(id);
    this.byId.delete(id);
    const index = this.objects.findIndex((object) => object.id === id);
    if (index !== -1) this.objects.splice(index, 1);
    return index !== -1;
  }

  add(object) {
    object.bounds = objectBounds(object);
    this.objects.push(object);
    this.objects.sort((left, right) => left.id - right.id);
    this.byId.set(object.id, object);
    this.grid.insert(object, object.bounds);
  }

  query(strategy) {
    return strategy === "brute"
      ? detectBruteForce(this.objects)
      : detectSpatialGrid(this.objects, this.grid);
  }
}

export function compareDetection(brute, indexed) {
  const bruteContacts = new Map(brute.contacts.map((contact) => [contactKey(contact), contact]));
  const indexedContacts = new Map(
    indexed.contacts.map((contact) => [contactKey(contact), contact])
  );
  const missingKeys = [];
  const extraKeys = [];
  const changedContacts = [];

  for (const [key, contact] of bruteContacts) {
    const candidate = indexedContacts.get(key);
    if (!candidate) {
      missingKeys.push(key);
      continue;
    }
    if (
      Math.abs(contact.depth - candidate.depth) > 1e-9 ||
      Math.abs(contact.nx - candidate.nx) > 1e-9 ||
      Math.abs(contact.ny - candidate.ny) > 1e-9
    ) {
      changedContacts.push(key);
    }
  }
  for (const key of indexedContacts.keys()) {
    if (!bruteContacts.has(key)) extraKeys.push(key);
  }

  return {
    equal: missingKeys.length === 0 && extraKeys.length === 0 && changedContacts.length === 0,
    missingKeys,
    extraKeys,
    changedContacts,
    bruteCount: brute.contacts.length,
    indexedCount: indexed.contacts.length,
    digestEqual: brute.digest === indexed.digest
  };
}

export function objectBounds(object) {
  if (object.shape === "circle") {
    return {
      minX: object.x - object.radius,
      minY: object.y - object.radius,
      maxX: object.x + object.radius,
      maxY: object.y + object.radius
    };
  }
  const halfWidth = object.width / 2;
  const halfHeight = object.height / 2;
  const cos = Math.cos(object.angle);
  const sin = Math.sin(object.angle);
  const extentX = Math.abs(cos) * halfWidth + Math.abs(sin) * halfHeight;
  const extentY = Math.abs(sin) * halfWidth + Math.abs(cos) * halfHeight;
  return {
    minX: object.x - extentX,
    minY: object.y - extentY,
    maxX: object.x + extentX,
    maxY: object.y + extentY
  };
}
