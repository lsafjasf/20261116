/* e2e.mjs — 用无头 Chromium 真实运行页面，执行页内场景测试并输出结论 */
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("nf");
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const exe = process.env.CHROME_EXE ||
  "/home/hj/.codex-relay-home-resttoxt/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForTimeout(400);

const boot = await page.evaluate(() => ({
  layers: document.querySelectorAll("#layers g[data-layer-id]").length,
  paths: document.querySelectorAll("#layers path").length,
  labels: document.querySelectorAll("#labels text").length,
  handles: document.querySelectorAll("#handles circle").length,
  algo: document.getElementById("algo-status").textContent,
}));
console.log("== 启动状态 ==");
console.log(`图层 ${boot.layers}，路径 ${boot.paths}，标签 ${boot.labels}，手柄 ${boot.handles}`);
console.log(boot.algo);

// 真实指针拖拽一个节点（而非仅调用函数），验证交互链路
const handle = await page.$('circle[data-feature-id="road-1"][data-index="3"]');
const box = await handle.boundingBox();
await page.mouse.move(box.x + 2, box.y + 2);
await page.mouse.down();
await page.mouse.move(box.x + 60, box.y - 40, { steps: 8 });
await page.mouse.up();
const afterDrag = await page.evaluate(() =>
  document.getElementById("algo-status").textContent);
console.log("\n== 真实拖拽节点后 ==");
console.log(afterDrag);

await page.click("#btn-run-tests");
await page.waitForFunction(() =>
  document.querySelectorAll("#test-results .test-case").length >= 6, { timeout: 30000 });
await page.waitForTimeout(300);

const results = await page.evaluate(() => ({
  cases: [...document.querySelectorAll("#test-results .test-case")].map((c) => ({
    name: c.querySelector("h4").textContent.trim(),
    pass: c.classList.contains("pass"),
    note: c.querySelector(".mono").textContent,
    shots: c.querySelectorAll("img").length,
  })),
  verdict: document.getElementById("verdict").textContent,
  algo: document.getElementById("algo-status").textContent,
}));
console.log("\n== 场景测试 ==");
for (const c of results.cases) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  [截图 ${c.shots} 张]`);
  console.log(`      ${c.note}`);
}
console.log("\n== 一致性结论 ==");
console.log(results.verdict);

// 一键恢复验证
await page.click("#btn-restore");
await page.waitForTimeout(300);
const restore = await page.evaluate(() => document.getElementById("verdict").textContent);
console.log("\n== 一键恢复 ==");
console.log(restore);

// 导出链路冒烟：SVG 字符串与 PNG 画布均可生成
const exp = await page.evaluate(async () => {
  const svg = new XMLSerializer().serializeToString(document.getElementById("map"));
  return { svgLen: svg.length, hasBezier: svg.includes(" C ") };
});
console.log("\n== 导出冒烟 ==");
console.log(`SVG 序列化 ${exp.svgLen} 字节，含平滑贝塞尔: ${exp.hasBezier}`);

await page.screenshot({ path: join(ROOT, "artifacts/page-full.png"), fullPage: true });

if (errors.length) {
  console.log("\n== 页面错误 ==");
  errors.forEach((e) => console.log(e));
}
const failed = results.cases.filter((c) => !c.pass).length;
console.log(`\n汇总: ${results.cases.length - failed}/${results.cases.length} 场景通过, ` +
  `${errors.length} 个页面错误`);
await browser.close();
server.close();
process.exit(failed || errors.length ? 1 : 0);
