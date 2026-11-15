// End-to-end simulation of the four required save paths:
//   normal save, corrupted file, legacy version, storage full
// plus an interrupted-write case. All runs use fresh, isolated directories.
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createGame } from "../src/core/game.js";
import { SaveSystem, PRIMARY, BACKUP } from "../src/save/save_system.js";
import { NodeStorage } from "../src/save/node_storage.js";
import { stableStringify, checksumText } from "../src/core/checksum.js";

const ROOT = join(process.cwd(), "userdata", "paths");

function freshDir(name) {
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function newGame() {
  const game = createGame({ seed: 20261116 });
  game.moveToward(12, 9);
  game.moveToward(6, 13);
  game.updateSettings({ volume: 0.55 });
  return game;
}

function banner(title) {
  console.log("\n=== " + title + " ===");
}

// 1. Normal save: primary + rotating backup, checksum verified on load.
function pathNormal() {
  banner("1. normal save / load");
  const dir = freshDir("normal");
  const system = new SaveSystem(new NodeStorage(dir));
  const game = newGame();
  const firstSnapshot = game.snapshot();
  const saveStatus = system.save(firstSnapshot);
  console.log("save:", saveStatus);
  const second = createGame({ seed: 20261116 });
  second.moveToward(3, 3);
  const secondSnapshot = second.snapshot();
  system.save(second.snapshot());
  const loaded = system.load();
  console.log("load:", loaded.status);
  console.log("attempts:", loaded.attempts);
  console.log(
    "round-trip equal:",
    stableStringify(loaded.payload) === stableStringify(secondSnapshot),
  );
}

// 2. Corruption: primary is truncated and its checksum breaks; the loader
// must fall back to the last complete backup snapshot.
function pathCorrupt() {
  banner("2. corrupted primary -> restore from backup");
  const dir = freshDir("corrupt");
  const storage = new NodeStorage(dir);
  const system = new SaveSystem(storage);
  const game = newGame();
  const goodSnapshot = game.snapshot();
  system.save(goodSnapshot);
  const next = createGame({ seed: 20261116 });
  next.moveToward(20, 12);
  system.save(next.snapshot());
  writeFileSync(
    join(dir, PRIMARY),
    readFileSync(join(dir, PRIMARY), "utf8").slice(0, 80) + "##GARBAGE##",
  );
  const loaded = system.load();
  console.log("load:", loaded.status);
  console.log("attempts:", loaded.attempts);
  console.log("recovery log:", system.recoveryLog);
  console.log(
    "restored equals last good snapshot:",
    stableStringify(loaded.payload) === stableStringify(goodSnapshot),
  );
}

// 3. Legacy version: hand-craft a v1 envelope, the loader migrates v1->v2->v3
// and reports the migration trail.
function pathLegacy() {
  banner("3. legacy v1 save -> migration to v3");
  const dir = freshDir("legacy");
  const game = newGame();
  const current = game.snapshot();
  const legacyPayload = {
    map: current.map,
    progress: {
      player: current.progress.player,
      score: current.progress.score,
      moves: current.progress.moves,
      tick: current.progress.tick,
      gems: current.progress.collected.length,
    },
    settings: { volume: 80, particles: true },
  };
  const body = stableStringify(legacyPayload);
  const envelope = {
    format: "offline-mini-save",
    version: 1,
    checksum: checksumText(body),
    createdAt: Date.now(),
    payload: legacyPayload,
  };
  writeFileSync(join(dir, PRIMARY), JSON.stringify(envelope));
  const system = new SaveSystem(new NodeStorage(dir));
  const loaded = system.load();
  console.log("load:", loaded.status);
  console.log("migration trail:", loaded.migrationTrail);
  console.log("migrated settings:", loaded.payload.settings);
  console.log("migrated collected:", loaded.payload.progress.collected);
  system.remigrateAndSave(loaded.payload);
  const reloaded = system.load();
  console.log(
    "re-saved version:",
    reloaded.status.version,
    "status:",
    reloaded.status.state,
  );
}

// 4. Storage full: a tiny quota rejects the write; the previous good copy
// must remain the loadable source of truth.
function pathQuota() {
  banner("4. storage quota exceeded -> existing snapshot retained");
  const dir = freshDir("quota");
  const storage = new NodeStorage(dir);
  const system = new SaveSystem(storage);
  system.save(newGame().snapshot());
  const tight = new NodeStorage(dir, { quotaBytes: 256 });
  const failing = new SaveSystem(tight);
  try {
    failing.save(createGame({ seed: 99 }).snapshot());
  } catch (error) {
    console.log("expected error:", error.code, "-", error.message);
  }
  console.log("status after failure:", failing.lastStatus);
  const loaded = system.load();
  console.log("fallback load:", loaded.status);
  console.log(
    "original data still intact:",
    loaded.ok && loaded.payload.map.seed === 20261116,
  );
}

// 5. Interrupted write: the temp key is truncated mid-save. Primary/backup
// are untouched, so the unique good copy is never overwritten.
function pathInterrupted() {
  banner("5. interrupted write -> temp damaged, good copies untouched");
  const dir = freshDir("interrupted");
  const storage = new NodeStorage(dir);
  const system = new SaveSystem(storage);
  system.save(newGame().snapshot());
  const before = readFileSync(join(dir, PRIMARY), "utf8");
  storage.options.failWrites = 1;
  try {
    system.save(createGame({ seed: 7 }).snapshot());
  } catch (error) {
    console.log("expected error:", error.code, "-", error.message);
  }
  const after = readFileSync(join(dir, PRIMARY), "utf8");
  console.log("primary unchanged:", before === after);
  console.log("backup exists:", existsSync(join(dir, BACKUP)));
  const loaded = system.load();
  console.log("reload status:", loaded.status, "| attempts:", loaded.attempts);
}

function main() {
  pathNormal();
  pathCorrupt();
  pathLegacy();
  pathQuota();
  pathInterrupted();
  console.log("\nAll save-path simulations finished under", ROOT);
}

main();
