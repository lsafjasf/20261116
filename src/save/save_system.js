import { checksumText, stableStringify } from "../core/checksum.js";
import { CURRENT_VERSION, migrate } from "./migrations.js";

export const PRIMARY = "save.primary.json";
export const BACKUP = "save.backup.json";
const TEMP = "save.tmp.json";

export class SaveError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SaveError";
    this.code = code;
    this.details = details;
  }
}

export class SaveSystem {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.clock = options.clock ?? (() => Date.now());
    this.lastStatus = {
      state: "idle",
      message: "No save attempted yet",
      at: this.clock(),
    };
    this.recoveryLog = [];
  }

  setStatus(state, message, extra = {}) {
    this.lastStatus = {
      state,
      message,
      at: this.clock(),
      ...extra,
    };
    return this.lastStatus;
  }

  logRecovery(entry) {
    this.recoveryLog.push({ at: this.clock(), ...entry });
    if (this.recoveryLog.length > 20) {
      this.recoveryLog.shift();
    }
  }

  buildEnvelope(payload) {
    const body = stableStringify(payload);
    const envelope = {
      format: "offline-mini-save",
      version: CURRENT_VERSION,
      checksum: checksumText(body),
      createdAt: this.clock(),
      payload,
    };
    return {
      envelope,
      text: JSON.stringify(envelope),
    };
  }

  // Atomic, never-overwrite-the-only-copy save:
  // 1. full envelope is written to a temp key (interrupts only damage temp)
  // 2. old primary is rotated to backup (the previous good copy survives)
  // 3. temp is renamed over primary
  // Any failure leaves the newest intact snapshot loadable.
  save(payload) {
    const { envelope, text } = this.buildEnvelope(payload);
    try {
      this.storage.remove(TEMP);
      this.storage.write(TEMP, text);
      const existingPrimary = this.storage.read(PRIMARY);
      if (existingPrimary !== null) {
        this.storage.remove(BACKUP);
        this.storage.write(BACKUP, existingPrimary);
      }
      this.storage.rename(TEMP, PRIMARY);
      return this.setStatus("saved", "Snapshot saved", {
        checksum: envelope.checksum,
        version: envelope.version,
        bytes:
          typeof Buffer !== "undefined"
            ? Buffer.byteLength(text)
            : new TextEncoder().encode(text).length,
      });
    } catch (error) {
      this.storage.remove(TEMP);
      this.logRecovery({
        kind: "save-failed",
        code: error.code ?? error.message,
        message: error.message,
      });
      if (error.code === "ENOSPC" || /quota/i.test(error.message)) {
        this.setStatus("quota", "Storage full; previous snapshot retained", {
          recoverable: true,
        });
        throw new SaveError(
          "Storage quota exceeded; existing save untouched",
          "ENOSPC",
          { cause: error.message },
        );
      }
      this.setStatus("save-failed", "Write interrupted; previous snapshot retained", {
        recoverable: true,
      });
      throw new SaveError("Interrupted write; existing save preserved", "EIO", {
        cause: error.message,
      });
    }
  }

  validate(rawText, slot) {
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (error) {
      return {
        ok: false,
        reason: "invalid-json",
        slot,
        message: error.message,
      };
    }
    if (!parsed || typeof parsed !== "object" || !parsed.payload) {
      return { ok: false, reason: "malformed-envelope", slot };
    }
    // Recompute from the parsed payload so key ordering inside the envelope
    // file never affects the result; only the payload data is checksummed.
    const expected = checksumText(stableStringify(parsed.payload));
    if (expected !== parsed.checksum) {
      return {
        ok: false,
        reason: "checksum-mismatch",
        slot,
        expected,
        actual: parsed.checksum,
      };
    }
    return { ok: true, envelope: parsed, slot };
  }

  // Tries primary then backup, migrates legacy payloads, and reports exactly
  // which recovery path was taken for the UI.
  load() {
    const slots = [
      { name: PRIMARY, label: "primary" },
      { name: BACKUP, label: "backup" },
    ];
    const attempts = [];
    for (const slot of slots) {
      const raw = this.storage.read(slot.name);
      if (raw === null || raw === undefined) {
        attempts.push({ slot: slot.label, result: "missing" });
        continue;
      }
      const verdict = this.validate(raw, slot.label);
      attempts.push({
        slot: slot.label,
        result: verdict.ok ? "valid" : verdict.reason,
      });
      if (!verdict.ok) {
        this.logRecovery({ kind: "corrupt", ...verdict });
        continue;
      }
      const envelope = verdict.envelope;
      let payload = envelope.payload;
      let migrationTrail = [envelope.version];
      if (envelope.version < CURRENT_VERSION) {
        try {
          const migrated = migrate(payload, envelope.version);
          payload = migrated.payload;
          migrationTrail = migrated.trail;
          this.logRecovery({
            kind: "migrated",
            from: envelope.version,
            trail: migrationTrail,
          });
        } catch (error) {
          this.logRecovery({
            kind: "migration-failed",
            version: envelope.version,
            message: error.message,
          });
          attempts.push({
            slot: slot.label,
            result: "unsupported-version",
          });
          continue;
        }
      }
      const recoveredFrom = slot.label === "backup" ? "backup" : "primary";
      const hadFailure = attempts.some(
        (attempt) =>
          attempt.slot === "primary" &&
          attempt.result !== "valid" &&
          attempt.result !== "missing",
      );
      this.setStatus(
        hadFailure ? "recovered" : "loaded",
        hadFailure
          ? "Primary snapshot unusable; restored from " + recoveredFrom
          : "Snapshot loaded",
        {
          recoveredFrom,
          migratedFrom:
            migrationTrail.length > 1 ? migrationTrail[0] : null,
          migrationTrail,
          checksum: envelope.checksum,
          version: envelope.version,
        },
      );
      return {
        ok: true,
        payload,
        status: this.lastStatus,
        attempts,
        migrationTrail,
      };
    }
    this.setStatus("empty", "No usable snapshot found; starting fresh", {
      recoverable: false,
    });
    return { ok: false, status: this.lastStatus, attempts };
  }

  // Persist a migrated legacy snapshot again so the on-disk version catches
  // up and the migration only has to run once.
  remigrateAndSave(payload) {
    return this.save(payload);
  }
}
