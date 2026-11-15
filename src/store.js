/* Persistence layer: saves UI state to localStorage (or any injected
 * storage with getItem/setItem). A failed restore never throws: it
 * returns the raw snapshot so the UI can show it to the user. */
(function (global) {
  "use strict";

  var KEY = "kf-importer-state-v1";

  function createStore(storage, key) {
    key = key || KEY;
    function save(state) {
      try {
        storage.setItem(key, JSON.stringify({
          version: 1,
          savedAt: new Date().toISOString(),
          state: state
        }));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    function load() {
      var raw;
      try {
        raw = storage.getItem(key);
      } catch (err) {
        return { ok: false, snapshot: null, error: String(err) };
      }
      if (raw == null) return { ok: true, state: null };
      try {
        var parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== 1 || typeof parsed.state !== "object") {
          return { ok: false, snapshot: raw, error: "存档版本或结构不兼容" };
        }
        return { ok: true, state: parsed.state, savedAt: parsed.savedAt };
      } catch (err) {
        return { ok: false, snapshot: raw, error: String(err) };
      }
    }
    function clear() {
      try { storage.removeItem(key); } catch (err) { /* ignore */ }
    }
    return { save: save, load: load, clear: clear, KEY: key };
  }

  var api = { createStore: createStore, KEY: KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.KfStore = api;
})(typeof self !== "undefined" ? self : globalThis);
