/* Node test suite for the keyframe importer core.
 * Run: node test/run_tests.js */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");

const { Sha256, sha256Hex } = require("../src/sha256.js");
const { StreamParser, pathAt, findSyntaxError, validateKeyframe } = require("../src/stream_parser.js");

// import_core expects the browser globals on globalThis in Node.
globalThis.KfSha256 = require("../src/sha256.js");
globalThis.KfParser = require("../src/stream_parser.js");
const { runImport } = require("../src/import_core.js");
const { createStore } = require("../src/store.js");

const VALID = path.join(__dirname, "..", "testdata", "keyframes_valid.json");
const BROKEN = path.join(__dirname, "..", "testdata", "keyframes_broken.json");

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log("ok - " + name);
  }).catch((err) => {
    console.error("FAIL - " + name);
    console.error(err);
    process.exitCode = 1;
  });
}

function fileSource(file) {
  const fd = fs.openSync(file, "r");
  return {
    size: fs.statSync(file).size,
    read(start, end) {
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return Promise.resolve(new Uint8Array(buf));
    }
  };
}

async function main() {
  await test("sha256 matches Node crypto (chunked)", () => {
    const data = crypto.randomBytes(3 * 1024 * 1024 + 17);
    const h = new Sha256();
    for (let off = 0; off < data.length; off += 65536) {
      h.update(data.subarray(off, Math.min(off + 65536, data.length)));
    }
    assert.strictEqual(h.digestHex(), crypto.createHash("sha256").update(data).digest("hex"));
    assert.strictEqual(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  await test("valid 100k file: count and hash correct", async () => {
    let progressEvents = 0;
    const result = await runImport(fileSource(VALID), { onProgress: () => progressEvents++ });
    assert.strictEqual(result.status, "done");
    assert.strictEqual(result.count, 100000);
    const expected = crypto.createHash("sha256").update(fs.readFileSync(VALID)).digest("hex");
    assert.strictEqual(result.hash, expected);
    assert.strictEqual(result.preview.length, 200);
    assert.ok(progressEvents > 0, "progress reported");
    console.log("    hash=" + result.hash + " durationMs=" + result.durationMs);
  });

  await test("broken file: schema error located to object and field", async () => {
    await assert.rejects(
      runImport(fileSource(BROKEN), {}),
      (err) => {
        assert.strictEqual(err.objectIndex, 51234);
        assert.strictEqual(err.path, "keyframes[51234].position[1]");
        assert.ok(err.message.includes("position"));
        return true;
      }
    );
  });

  await test("syntax error located to object and field", () => {
    const good = JSON.stringify({ id: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], meta: { bone: "r", easing: "linear" } });
    const bad = good.replace('"time":0', '"time":');
    const text = "[" + good + "," + good + "," + bad + "]";
    const p = new StreamParser({});
    assert.throws(() => { p.push(text); p.end(); }, (err) => {
      assert.strictEqual(err.objectIndex, 2);
      assert.strictEqual(err.path, "keyframes[2].time");
      return true;
    });
  });

  await test("cancel mid-import: no partial commit", async () => {
    // Simulates the app contract: staging is discarded unless status==='done'.
    const committed = { count: null, hash: null };
    let calls = 0;
    const result = await runImport(fileSource(VALID), {}, () => ++calls > 3);
    assert.strictEqual(result.status, "cancelled");
    assert.ok(result.parsed < 100000);
    if (result.status === "done") { committed.count = result.count; committed.hash = result.hash; }
    assert.strictEqual(committed.count, null);
    assert.strictEqual(committed.hash, null);
  });

  await test("truncated file reported with object index", () => {
    const head = fs.readFileSync(VALID, "utf8").slice(0, 5000);
    const p = new StreamParser({});
    assert.throws(() => { p.push(head); p.end(); }, (err) => {
      assert.ok(err.objectIndex !== null || err.message.includes("截断"));
      return true;
    });
  });

  await test("store roundtrip and corrupted snapshot", () => {
    const mem = new Map();
    const storage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k)
    };
    const store = createStore(storage, "t");
    const state = { notes: "草稿", selectedIndex: 42, scrollTop: 1337, result: { count: 100000, hash: "ab" } };
    assert.deepStrictEqual(store.save(state), { ok: true });
    const loaded = store.load();
    assert.strictEqual(loaded.ok, true);
    assert.deepStrictEqual(loaded.state, state);
    mem.set("t", "{corrupted json!!!");
    const failed = store.load();
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.snapshot, "{corrupted json!!!");
    mem.set("t", JSON.stringify({ version: 99, state: {} }));
    assert.strictEqual(store.load().ok, false);
  });

  await test("pathAt / findSyntaxError / validateKeyframe units", () => {
    assert.deepStrictEqual(pathAt('{"a":[1,{"b":"x"}]}', 14), ["a", 1, "b"]);
    assert.strictEqual(findSyntaxError('{"a":1}'), -1);
    assert.strictEqual(findSyntaxError('{"a":}'), 5);
    assert.strictEqual(validateKeyframe({ id: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], meta: { bone: "b", easing: "step" } }), null);
    assert.strictEqual(validateKeyframe({ id: -1 }).path, "id");
    assert.strictEqual(validateKeyframe({ id: 0, time: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], meta: { bone: "b", easing: "warp" } }).path, "meta.easing");
  });

  console.log(passed + " tests passed" + (process.exitCode ? " (with failures)" : ""));
}

main();
