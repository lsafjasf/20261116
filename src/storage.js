import * as C from './config.js';
import { Simulation, hashObject } from './simulation.js';
import { Recording } from './recorder.js';

// The save slot stores the live simulation snapshot plus the full recording,
// so reloading restores both gauges/durability and task progress.
export function saveGame(sim, scenario) {
  const recording = Recording.capture(sim, scenario);
  const payload = {
    savedAt: new Date().toISOString(),
    scenario,
    snapshot: sim.snapshot(),
    snapshotHash: hashObject(sim.snapshot()),
    recording: JSON.parse(recording.serialize()),
    progress: {
      tick: sim.tick,
      totalTicks: C.TOTAL_TICKS,
      percent: Number(((sim.tick / C.TOTAL_TICKS) * 100).toFixed(2)),
      ended: sim.ended
    }
  };
  getStore().setItem(C.SAVE_KEY, JSON.stringify(payload));
  return payload;
}

export function loadGame() {
  const raw = getStore().getItem(C.SAVE_KEY);
  if (!raw) return null;
  const payload = JSON.parse(raw);
  const sim = new Simulation(payload.snapshot.seed).restore(payload.snapshot);
  const recording = Recording.parse(payload.recording);
  if (hashObject(sim.snapshot()) !== payload.snapshotHash) {
    throw new Error('save slot corrupted: snapshot hash mismatch');
  }
  return { sim, recording, payload };
}

export function clearSave() {
  getStore().removeItem(C.SAVE_KEY);
}

export function hasSave() {
  return Boolean(getStore().getItem(C.SAVE_KEY));
}

// In Node there is no localStorage; the headless runner installs a shim.
function getStore() {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (globalThis.__memoryStore) return globalThis.__memoryStore;
  const mem = new MemoryStore();
  globalThis.__memoryStore = mem;
  return mem;
}

export class MemoryStore {
  constructor() {
    this.data = new Map();
  }
  getItem(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }
  setItem(key, value) {
    this.data.set(key, String(value));
  }
  removeItem(key) {
    this.data.delete(key);
  }
}
