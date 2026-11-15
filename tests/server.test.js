import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = 16000 + (process.pid % 10000);

async function waitForServer(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  }
  throw new Error("Server did not start");
}

test("HTTP workbench serves health, app module and core module", async (t) => {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`;
  const health = await waitForServer(`${base}/api/health`);
  assert.equal((await health.json()).ok, true);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Atlas Lab/);
  const app = await fetch(`${base}/app.js`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get("content-type"), /javascript/);
  const core = await fetch(`${base}/core/packer.js`);
  assert.equal(core.status, 200);
  assert.match(await core.text(), /class StableAtlasPacker/);
  const missing = await fetch(`${base}/missing.js`);
  assert.equal(missing.status, 404);
});
