import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

// Filesystem key/value storage used by Node tests and the headless demo.
// Fault injection mirrors the browser adapter:
//   failWrites:  number of writes that fail mid-way (truncated temp left)
//   corruptWrite true makes the next write persist garbage instead of data
//   quotaBytes:  hard limit on total bytes held in the directory
export class NodeStorage {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.options = options;
    this.events = [];
    mkdirSync(directory, { recursive: true });
  }

  path(name) {
    return join(this.directory, name);
  }

  read(name) {
    const file = this.path(name);
    if (!existsSync(file)) {
      return null;
    }
    return readFileSync(file, "utf8");
  }

  write(name, text) {
    this.events.push({ op: "write", name, bytes: Buffer.byteLength(text) });
    if ((this.options.failWrites ?? 0) > 0) {
      this.options.failWrites--;
      const partial = text.slice(0, Math.max(1, Math.floor(text.length / 3)));
      writeFileSync(this.path(name), partial, "utf8");
      this.events.push({ op: "interrupted", name });
      const error = new Error("EIO: simulated interrupted write");
      error.code = "EIO";
      throw error;
    }
    if (this.options.corruptWrite) {
      this.options.corruptWrite = false;
      writeFileSync(this.path(name), "CORRUPT-" + text.slice(0, 16), "utf8");
      return;
    }
    const desired = Buffer.byteLength(text);
    if (this.options.quotaBytes != null) {
      const used = this.usedBytes();
      const current = existsSync(this.path(name))
        ? statSync(this.path(name)).size
        : 0;
      if (used - current + desired > this.options.quotaBytes) {
        const error = new Error("ENOSPC: simulated storage quota exceeded");
        error.code = "ENOSPC";
        this.events.push({ op: "quota", name });
        throw error;
      }
    }
    writeFileSync(this.path(name), text, "utf8");
  }

  remove(name) {
    if (existsSync(this.path(name))) {
      rmSync(this.path(name));
    }
  }

  rename(from, to) {
    renameSync(this.path(from), this.path(to));
  }

  usedBytes() {
    if (!existsSync(this.directory)) {
      return 0;
    }
    return readdirSync(this.directory).reduce((sum, name) => {
      return sum + statSync(this.path(name)).size;
    }, 0);
  }
}
