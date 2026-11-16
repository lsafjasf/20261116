// Isomorphic persistence. Browser uses localStorage; Node injects a memory shim.
const KEY = 'ice-rescue-duo/save/v1';

function getBackend(custom) {
  if (custom) return custom;
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  const memory = new Map();
  return {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  };
}

export function saveGame({ state, scenarioId, tickInputs, backend = null }) {
  const store = getBackend(backend);
  const payload = {
    version: 1,
    savedAt: new Date(0).toISOString(),
    scenarioId,
    seed: state.seed,
    tick: state.tick,
    state,
    tickInputs,
  };
  store.setItem(KEY, JSON.stringify(payload));
  return payload;
}

export function loadGame(backend = null) {
  const store = getBackend(backend);
  const raw = store.getItem(KEY);
  if (!raw) return null;
  return JSON.parse(raw);
}

export function clearSave(backend = null) {
  getBackend(backend).removeItem(KEY);
}

// Reconstruct the live engine state purely from recorded inputs, then compare
// against the persisted snapshot to prove reload restores identical values.
export function verifyReload(save, { createState, runStep, checksumOf }) {
  const rebuilt = createState(save.seed);
  for (let i = 0; i < save.tickInputs.length; i += 1) {
    runStep(rebuilt, save.tickInputs[i]);
  }
  return {
    tick: rebuilt.tick,
    expectedTick: save.tick,
    rebuiltChecksum: checksumOf(rebuilt),
    savedChecksum: checksumOf(save.state),
    ok: checksumOf(rebuilt) === checksumOf(save.state) && rebuilt.tick === save.tick,
    gauges: {
      tension: rebuilt.gauges.tension,
      guideLoad: rebuilt.gauges.guideLoad,
      stress: rebuilt.gauges.stress,
      spoolSpeed: rebuilt.gauges.spoolSpeed,
      winchInput: rebuilt.gauges.winchInput,
      steerX: rebuilt.gauges.steerX,
      steerY: rebuilt.gauges.steerY,
    },
    integrity: rebuilt.integrity,
    progress: rebuilt.progress,
    status: rebuilt.status,
  };
}

export { KEY };
