// localStorage-backed key/value storage for the offline browser build.
// Same interface and same fault-injection knobs as NodeStorage so the four
// failure paths can be demonstrated live in the UI.
export class BrowserStorage {
  constructor(prefix = "miniSave:", backend = globalThis.localStorage, options = {}) {
    this.prefix = prefix;
    this.backend = backend;
    this.options = options;
    this.events = [];
  }

  key(name) {
    return this.prefix + name;
  }

  read(name) {
    return this.backend.getItem(this.key(name));
  }

  write(name, text) {
    this.events.push({ op: "write", name, bytes: text.length });
    if ((this.options.failWrites ?? 0) > 0) {
      this.options.failWrites--;
      const partial = text.slice(0, Math.max(1, Math.floor(text.length / 3)));
      this.backend.setItem(this.key(name), partial);
      this.events.push({ op: "interrupted", name });
      throw new Error("Simulated interrupted write");
    }
    if (this.options.corruptWrite) {
      this.options.corruptWrite = false;
      this.backend.setItem(this.key(name), "CORRUPT-" + text.slice(0, 16));
      return;
    }
    if (this.options.quotaBytes != null) {
      const used = this.usedBytes();
      const current = this.backend.getItem(this.key(name));
      const currentSize = current ? current.length : 0;
      if (used - currentSize + text.length > this.options.quotaBytes) {
        this.events.push({ op: "quota", name });
        throw new Error("Simulated storage quota exceeded (ENOSPC)");
      }
    }
    this.backend.setItem(this.key(name), text);
  }

  remove(name) {
    this.backend.removeItem(this.key(name));
  }

  rename(from, to) {
    const value = this.backend.getItem(this.key(from));
    if (value === null) {
      throw new Error("rename source missing: " + from);
    }
    this.backend.setItem(this.key(to), value);
    this.backend.removeItem(this.key(from));
  }

  usedBytes() {
    let total = 0;
    for (let i = 0; i < this.backend.length; i++) {
      const key = this.backend.key(i);
      if (key && key.startsWith(this.prefix)) {
        total += this.backend.getItem(key).length;
      }
    }
    return total;
  }
}
