/* Browser acceptance tests (Playwright, headless Chromium).
 * Covers the same task twice: once mouse-driven, once keyboard-driven.
 * Run: node test/acceptance.js */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const VALID = path.join(ROOT, "testdata", "keyframes_valid.json");
const BROKEN = path.join(ROOT, "testdata", "keyframes_broken.json");
const BIG = path.join(ROOT, "testdata", "keyframes_big.json");
const EXPECTED_HASH = crypto.createHash("sha256").update(fs.readFileSync(VALID)).digest("hex");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html");
    fs.readFile(p.endsWith("/") ? p + "index.html" : p, (err, data) => {
      if (err) { res.writeHead(404); res.end("nf"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream" });
      res.end(data);
    });
  });

  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("ok - " + name); }
  catch (err) { console.error("FAIL - " + name); console.error(err.message); process.exitCode = 1; }
}

const text = (page, sel) => page.locator(sel).textContent();

async function mouseFlow(page) {
  await page.goto("/");
  await page.setInputFiles("#fileInput", VALID);
  await page.click("#importBtn");
  await page.waitForSelector("#resultPanel:not([hidden])", { timeout: 30000 });

  await check("鼠标: 数量与哈希正确", async () => {
    assert.strictEqual((await text(page, "#resCount")).trim(), "100,000");
    assert.strictEqual((await text(page, "#resHash")).trim(), EXPECTED_HASH);
  });

  await check("鼠标: 点击选中对象", async () => {
    await page.click("#kf-row-3");
    assert.match(await text(page, "#selInfo"), /#3/);
  });

  await check("鼠标: 草稿、选中、滚动位置在刷新后保留", async () => {
    await page.fill("#notes", "鼠标流程草稿 v1");
    await page.click("#commitNotesBtn");
    await page.fill("#notes", "鼠标流程草稿 v2（未提交）");
    await page.locator("#listBox").evaluate((el) => { el.scrollTop = 140; });
    await page.waitForTimeout(500); // debounced save
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#listBox").scrollTop > 100);
    assert.strictEqual(await page.locator("#notes").inputValue(), "鼠标流程草稿 v2（未提交）");
    assert.match(await text(page, "#selInfo"), /#3/);
    assert.strictEqual((await text(page, "#resHash")).trim(), EXPECTED_HASH);
  });

  await check("鼠标: 损坏文件报错定位到对象与字段", async () => {
    await page.setInputFiles("#fileInput", BROKEN);
    await page.click("#importBtn");
    await page.waitForSelector("#errorPanel:not([hidden])", { timeout: 30000 });
    assert.strictEqual((await text(page, "#errObject")).trim(), "51234");
    assert.strictEqual((await text(page, "#errPath")).trim(), "keyframes[51234].position[1]");
    assert.match(await text(page, "#statusRegion"), /失败/);
  });

  await check("鼠标: 取消不留半成品且界面可响应", async () => {
    await page.setInputFiles("#fileInput", BIG);
    await page.click("#importBtn");
    await page.waitForSelector("#progressDialog[open]");
    const t0 = Date.now();
    await page.evaluate(() => 1 + 1); // main thread must stay responsive
    assert.ok(Date.now() - t0 < 500, "main thread responsive during import");
    await page.click("#cancelBtn");
    await page.waitForFunction(() =>
      document.querySelector("#statusRegion").textContent.includes("取消"), { timeout: 15000 });
    assert.strictEqual((await text(page, "#resHash")).trim(), EXPECTED_HASH); // 旧结果未被覆盖
    assert.strictEqual((await text(page, "#resCount")).trim(), "100,000");
  });

  await check("鼠标: 恢复失败保留可读快照", async () => {
    await page.evaluate(() => localStorage.setItem("kf-importer-state-v1", "{corrupted!!!"));
    await page.reload();
    await page.waitForSelector("#snapshotBanner:not([hidden])");
    assert.match(await text(page, "#snapshotText"), /\{corrupted!!!/);
    assert.match(await text(page, "#debugState"), /restore-failed/);
  });
}

async function keyboardFlow(page) {
  await page.goto("/");
  await page.setInputFiles("#fileInput", VALID); // 文件对话框无法纯键盘操作

  await check("键盘: 焦点顺序正确", async () => {
    await page.evaluate(() => document.body.focus());
    const order = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      order.push(await page.evaluate(() => document.activeElement.id || document.activeElement.tagName));
    }
    assert.deepStrictEqual(order.slice(0, 5),
      ["fileInput", "importBtn", "notes", "commitNotesBtn", "listBox"]);
  });

  await check("键盘: Enter 启动导入，焦点进入弹窗取消按钮", async () => {
    await page.focus("#importBtn");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#progressDialog[open]");
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "cancelBtn");
  });

  await check("键盘: Esc 取消导入且状态可读", async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() =>
      document.querySelector("#statusRegion").textContent.includes("取消"), { timeout: 15000 });
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), "importBtn");
  });

  await check("键盘: 再次 Enter 完成导入，数量哈希正确", async () => {
    await page.keyboard.press("Enter");
    await page.waitForSelector("#resultPanel:not([hidden])", { timeout: 30000 });
    assert.strictEqual((await text(page, "#resCount")).trim(), "100,000");
    assert.strictEqual((await text(page, "#resHash")).trim(), EXPECTED_HASH);
  });

  await check("键盘: 方向键选择对象并同步 aria 状态", async () => {
    await page.focus("#listBox");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert.match(await text(page, "#selInfo"), /#2/);
    assert.strictEqual(await page.locator("#listBox").getAttribute("aria-activedescendant"), "kf-row-2");
    const row = page.locator("#kf-row-2");
    assert.strictEqual(await row.getAttribute("aria-selected"), "true");
  });

  await check("键盘: 备注提交与撤销不丢失选中/滚动", async () => {
    await page.focus("#notes");
    await page.keyboard.type("键盘备注 v1");
    await page.focus("#commitNotesBtn");
    await page.keyboard.press("Enter");
    await page.focus("#notes");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("键盘备注 v2");
    await page.focus("#undoBtn");
    await page.keyboard.press("Enter");
    assert.strictEqual(await page.locator("#notes").inputValue(), "键盘备注 v1");
    assert.match(await text(page, "#selInfo"), /#2/); // 撤销未影响选中
  });

  await check("键盘: 状态区与调试面板可读", async () => {
    assert.strictEqual(await page.locator("#statusRegion").getAttribute("role"), "status");
    assert.match(await text(page, "#statusRegion"), /完成/);
    const dbg = await text(page, "#debugState");
    assert.match(dbg, /"phase": "done"/);
    assert.match(dbg, /"选中对象": 2/);
    assert.match(dbg, new RegExp(EXPECTED_HASH.slice(0, 16)));
  });
}

(async () => {
  const server = await serve();
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch();
  try {
    const ctx1 = await browser.newContext({ baseURL: base });
    await mouseFlow(await ctx1.newPage());
    const ctx2 = await browser.newContext({ baseURL: base });
    await keyboardFlow(await ctx2.newPage());
  } finally {
    await browser.close();
    server.close();
  }
  console.log(passed + " acceptance checks passed" + (process.exitCode ? " (with failures)" : ""));
})();
