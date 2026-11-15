import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { SaveSystem, PRIMARY, BACKUP } from "../src/save/save_system.js";
import { NodeStorage } from "../src/save/node_storage.js";
import { migrate, UnsupportedVersionError } from "../src/save/migrations.js";
import { checksumText, stableStringify } from "../src/core/checksum.js";
import { createGame } from "../src/core/game.js";

const BASE = join(process.cwd(), "userdata", "test-runs");

function dir(name) {
  const target = join(BASE, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  return target;
}

function snapshot() {
  const game = createGame({ seed: 11 });
  game.moveToward(8, 6);
  game.updateSettings({ volume: 0.4 });
  return game.snapshot();
}

test("checksum detects single-byte corruption", () => {
  const text = stableStringify({ a: 1, b: [2, 3] });
  assert.notEqual(checksumText(text + " "), checksumText(text));
  assert.equal(checksumText(text), checksumText(stableStringify({ b: [2, 3], a: 1 })));
});

test("save then load returns an identical payload", () => {
  const system = new SaveSystem(new NodeStorage(dir("roundtrip")));
  const data = snapshot();
  system.save(data);
  const result = system.load();
  assert.equal(result.ok, true);
  assert.equal(
    stableStringify(result.payload),
    stableStringify(data),
  );
  assert.equal(result.status.state, "loaded");
});

test("corrupt primary falls back to the last good backup", () => {
  const target = dir("corrupt");
  const system = new SaveSystem(new NodeStorage(target));
  const good = snapshot();
  system.save(good);
  const newer = snapshot();
  newer.progress.score = 999;
  system.save(newer);
  writeFileSync(
    join(target, PRIMARY),
    readFileSync(join(target, PRIMARY), "utf8").slice(0, 50) + "!!!",
  );
  const result = system.load();
  assert.equal(result.ok, true);
  assert.equal(result.status.state, "recovered");
  assert.equal(result.status.recoveredFrom, "backup");
  assert.equal(
    stableStringify(result.payload),
    stableStringify(good),
  );
});

test("checksum mismatch on both snapshots reports empty, not crash", () => {
  const target = dir("both-corrupt");
  const storage = new NodeStorage(target);
  const system = new SaveSystem(storage);
  system.save(snapshot());
  storage.write(PRIMARY, "{not-json");
  storage.write(BACKUP, "{not-json");
  const result = system.load();
  assert.equal(result.ok, false);
  assert.equal(result.status.state, "empty");
});

test("interrupted write never overwrites the only good copy", () => {
  const target = dir("interrupted");
  const storage = new NodeStorage(target);
  const system = new SaveSystem(storage);
  system.save(snapshot());
  const before = readFileSync(join(target, PRIMARY), "utf8");
  storage.options.failWrites = 1;
  assert.throws(
    () => system.save(snapshot()),
    (error) => error.code === "EIO",
  );
  assert.equal(readFileSync(join(target, PRIMARY), "utf8"), before);
  assert.equal(existsSync(join(target, "save.tmp.json")), false);
});

test("quota failure preserves the existing snapshot", () => {
  const target = dir("quota");
  const system = new SaveSystem(new NodeStorage(target));
  const data = snapshot();
  system.save(data);
  const tight = new SaveSystem(new NodeStorage(target, { quotaBytes: 64 }));
  assert.throws(
    () => tight.save(snapshot()),
    (error) => error.code === "ENOSPC",
  );
  const reloaded = system.load();
  assert.equal(reloaded.ok, true);
  assert.equal(
    stableStringify(reloaded.payload),
    stableStringify(data),
  );
});

test("v1 payload migrates through v2 to v3", () => {
  const result = migrate(
    {
      map: { id: "m" },
      progress: { gems: 2 },
      settings: { volume: 50 },
    },
    1,
  );
  assert.deepEqual(result.trail, [1, 2, 3]);
  assert.equal(result.payload.settings.volume, 0.5);
  assert.equal(result.payload.settings.difficulty, "normal");
  assert.equal(result.payload.progress.collected.length, 2);
  assert.ok(result.payload.replaySummary);
});

test("unsupported versions raise an explicit, actionable error", () => {
  assert.throws(
    () => migrate({ settings: {} }, 99),
    (error) =>
      error instanceof UnsupportedVersionError && error.version === 99,
  );
});

test("rotation keeps exactly two snapshot slots", () => {
  const target = dir("rotation");
  const system = new SaveSystem(new NodeStorage(target));
  for (let i = 0; i < 5; i++) {
    const data = snapshot();
    data.progress.score = i;
    system.save(data);
  }
  assert.ok(existsSync(join(target, PRIMARY)));
  assert.ok(existsSync(join(target, BACKUP)));
  const files = readdirSync(target);
  assert.deepEqual(files.sort(), [BACKUP, PRIMARY].sort());
});
