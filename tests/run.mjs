// Acceptance tests: overflow, focus order, wrapping, persistence, mouse & keyboard flows.
import { chromium } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { mkdir } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const SHOTS = join(ROOT, "artifacts", "screenshots");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  try {
    const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] || "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

await mkdir(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
}

const browser = await chromium.launch();

async function newPage(width = 1280, height = 800) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  return { ctx, page };
}

async function overflowReport(page) {
  return page.evaluate(() => {
    const bad = [];
    const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (docOverflow > 1) bad.push(`document x-overflow by ${docOverflow}px`);
    document
      .querySelectorAll("button, label, h1, h2, dt, dd, p, select, .toast")
      .forEach((el) => {
        const over = el.scrollWidth - el.clientWidth;
        if (over > 1) bad.push(`${el.tagName}#${el.id || el.textContent.slice(0, 12)} +${over}px`);
      });
    return bad;
  });
}

/* ---------- 1. narrow-screen overflow in all 3 languages ---------- */
for (const lang of ["zh-CN", "en", "ar"]) {
  const { ctx, page } = await newPage(360, 700);
  await page.getByTestId("language-select").selectOption(lang);
  await page.getByTestId("toolbar").getByRole("button").first().click(); // add rect
  await page.getByRole("button", { name: /帮助|Help|مساعدة/ }).click();
  const bad = await overflowReport(page);
  check(`overflow: 360px ${lang} (with dialog)`, bad.length === 0, bad.join("; "));
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(SHOTS, `narrow-360-${lang}.png`), fullPage: true });
  await ctx.close();
}

/* ---------- 2. long-sentence wrapping inside dialog ---------- */
{
  const { ctx, page } = await newPage(360, 700);
  await page.getByTestId("toolbar").getByRole("button").nth(5).click(); // help
  const wrap = await page.evaluate(() => {
    const dlg = document.getElementById("help-dialog");
    const body = document.getElementById("help-body");
    return {
      dlgOverflow: dlg.scrollWidth - dlg.clientWidth,
      bodyLines: body.getClientRects().length,
      bodyH: body.offsetHeight,
    };
  });
  check("wrap: long sentence wraps, no dialog x-overflow", wrap.dlgOverflow <= 1 && wrap.bodyH > 60,
    JSON.stringify(wrap));
  await ctx.close();
}

/* ---------- 3. keyboard focus order ---------- */
{
  const { ctx, page } = await newPage();
  await page.getByTestId("toolbar").getByRole("button").nth(0).click(); // rect
  await page.getByTestId("toolbar").getByRole("button").nth(1).click(); // text
  const seq = [];
  await page.keyboard.press("Tab"); // move away from focused object first
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const el = document.activeElement;
      return el.id || el.dataset.testid || el.tagName;
    });
    seq.push(id);
  }
  const expected = [
    "language-select", "btn-add-rect", "btn-add-text", "btn-delete", "btn-undo",
    "btn-submit", "btn-help", "canvas",
  ];
  const orderOk = expected.every((v, i) => seq[i] === v);
  const hasObjects = seq.slice(8).some((s) => s.startsWith("canvas-object-"));
  check("focus: Tab order lang→toolbar→canvas→objects", orderOk && hasObjects, seq.join(" → "));

  // visible focus indicator on a focused object
  await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    const s = getComputedStyle(el);
    return { outline: s.outlineWidth + " " + s.outlineStyle, cls: el.className };
  });
  check("focus: visible focus ring", /3px/.test(ring.outline), JSON.stringify(ring));
  await ctx.close();
}

/* ---------- helpers for object state ---------- */
async function objectState(page) {
  return page.evaluate(() =>
    window.__app.state.objects.map((o) => ({ id: o.id, x: o.x, y: o.y, text: o.text }))
  );
}

/* ---------- 4. language switch keeps content & coordinates ---------- */
{
  const { ctx, page } = await newPage();
  await page.getByTestId("toolbar").getByRole("button").nth(0).click();
  await page.getByTestId("toolbar").getByRole("button").nth(1).click();
  const before = await objectState(page);
  for (const lang of ["en", "ar", "zh-CN"]) {
    await page.getByTestId("language-select").selectOption(lang);
    const after = await objectState(page);
    const same =
      after.length === before.length &&
      after.every((o, i) => o.x === before[i].x && o.y === before[i].y && o.text === before[i].text);
    check(`i18n: switch to ${lang} keeps objects/coords`, same, JSON.stringify(after.map((o) => [o.x, o.y])));
  }
  const dir = await page.evaluate(() => document.documentElement.dir);
  await page.getByTestId("language-select").selectOption("ar");
  const dirAr = await page.evaluate(() => document.documentElement.dir);
  check("i18n: RTL applied for Arabic", dirAr === "rtl" && dir === "ltr", `dir=${dirAr}`);
  await ctx.close();
}

/* ---------- 5. mouse flow: add → drag → edit → submit ---------- */
{
  const { ctx, page } = await newPage();
  await page.getByRole("button", { name: "添加矩形" }).click();
  const obj = page.getByTestId("canvas-object-1");
  const start = (await objectState(page))[0];
  const box = await obj.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 90, { steps: 5 });
  await page.mouse.up();
  const moved = await objectState(page);
  check("mouse: drag moves object", moved[0].x === start.x + 100 && moved[0].y === start.y + 70,
    JSON.stringify(moved[0]));

  await obj.dblclick();
  await page.getByTestId("object-editor").fill("鼠标输入 Mouse 文本 123");
  await page.keyboard.press("Enter");
  const edited = await objectState(page);
  check("mouse: dblclick edit commits text", edited[0].text === "鼠标输入 Mouse 文本 123", edited[0].text);

  await page.getByRole("button", { name: "提交" }).click();
  const toast = await page.getByTestId("toast").textContent();
  const count = await page.evaluate(() => window.__app.state.objects.length);
  check("mouse: submit clears canvas with ok toast", count === 0 && /成功/.test(toast), toast);
  await ctx.close();
}

/* ---------- 6. keyboard flow: same task with keys only ---------- */
{
  const { ctx, page } = await newPage();
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("Tab"); // language-select
  await page.keyboard.press("Tab"); // add rect
  await page.keyboard.press("Tab"); // add text
  await page.keyboard.press("Enter"); // activate add text
  const focused = await page.evaluate(() => document.activeElement.dataset.testid);
  check("keyboard: new object receives focus", focused === "canvas-object-1", focused);

  await page.keyboard.press("Enter"); // open editor
  await page.keyboard.type("键盘输入 Keyboard 文本 456");
  await page.keyboard.press("Enter"); // commit
  const edited = await objectState(page);
  check("keyboard: Enter edits & commits", edited[0].text === "键盘输入 Keyboard 文本 456", edited[0].text);

  await page.keyboard.press("Control+z"); // undo text edit
  const undone = await objectState(page);
  const stillThere = undone.length === 1 && undone[0].text !== "键盘输入 Keyboard 文本 456";
  const sel = await page.evaluate(() => window.__app.state.selectedId);
  check("keyboard: undo restores text, keeps object & selection", stillThere && sel === 1,
    `sel=${sel} text=${undone[0] && undone[0].text}`);

  // submit via keyboard: Tab to submit button then Enter
  for (let i = 0; i < 8; i++) {
    const id = await page.evaluate(() => document.activeElement.id);
    if (id === "btn-submit") break;
    await page.keyboard.press("Tab");
  }
  await page.keyboard.press("Enter");
  const count = await page.evaluate(() => window.__app.state.objects.length);
  check("keyboard: submit via Enter works", count === 0, `count=${count}`);
  await ctx.close();
}

/* ---------- 7. failure message readable ---------- */
{
  const { ctx, page } = await newPage();
  await page.getByRole("button", { name: "提交" }).click(); // empty canvas
  const toast = await page.getByTestId("toast").textContent();
  const cls = await page.getByTestId("toast").getAttribute("class");
  check("failure: empty submit shows readable error", /失败/.test(toast) && cls.includes("err"), toast);
  await ctx.close();
}

/* ---------- 8. refresh keeps draft, selection, scroll ---------- */
{
  const { ctx, page } = await newPage();
  await page.getByTestId("toolbar").getByRole("button").nth(0).click();
  await page.getByTestId("toolbar").getByRole("button").nth(1).click();
  await page.getByTestId("canvas-scroll").evaluate((el) => {
    el.scrollLeft = 180;
    el.scrollTop = 120;
  });
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => ({
    objs: window.__app.state.objects.length,
    sel: window.__app.state.selectedId,
    dirty: window.__app.state.dirty,
  }));
  await page.reload();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({
    objs: window.__app.state.objects.length,
    sel: window.__app.state.selectedId,
    dirty: window.__app.state.dirty,
    scrollLeft: document.getElementById("canvas-scroll").scrollLeft,
    scrollTop: document.getElementById("canvas-scroll").scrollTop,
  }));
  const ok =
    after.objs === before.objs && after.sel === before.sel && after.dirty === true &&
    after.scrollLeft === 180 && after.scrollTop === 120;
  check("persist: refresh restores draft/selection/scroll", ok, JSON.stringify(after));
  await ctx.close();
}

/* ---------- 9. closing dialog loses nothing ---------- */
{
  const { ctx, page } = await newPage();
  await page.getByTestId("toolbar").getByRole("button").nth(0).click();
  const before = await objectState(page);
  await page.getByTestId("toolbar").getByRole("button").nth(5).click(); // help
  await page.keyboard.press("Escape");
  const after = await objectState(page);
  const sel = await page.evaluate(() => window.__app.state.selectedId);
  check("dialog: close keeps objects & selection",
    JSON.stringify(after) === JSON.stringify(before) && sel === 1, `sel=${sel}`);
  await ctx.close();
}

/* ---------- 10. corrupted snapshot -> readable raw snapshot ---------- */
{
  const { ctx, page } = await newPage();
  await page.evaluate(() => localStorage.setItem(window.__app.STORAGE_KEY, "{corrupted!!"));
  await page.reload();
  const banner = await page.locator("#recover-banner").isVisible();
  const raw = await page.getByTestId("recover-snapshot").textContent();
  const usable = await page.evaluate(() => {
    document.getElementById("btn-add-rect").click();
    return window.__app.state.objects.length;
  });
  check("recover: corrupt snapshot shows readable raw copy", banner && raw === "{corrupted!!", raw);
  check("recover: app still usable after failed restore", usable === 1, `objects=${usable}`);
  await ctx.close();
}

/* ---------- 11. status panel reflects input/storage/render sync ---------- */
{
  const { ctx, page } = await newPage();
  await page.getByTestId("toolbar").getByRole("button").nth(0).click();
  const st = await page.evaluate(() => ({
    count: document.getElementById("st-count").textContent,
    dirty: document.getElementById("st-dirty").textContent,
    selected: document.getElementById("st-selected").textContent,
    storage: document.getElementById("st-storage").textContent,
    realCount: window.__app.state.objects.length,
    stored: JSON.parse(localStorage.getItem(window.__app.STORAGE_KEY)).objects.length,
  }));
  const ok = st.count === "1" && st.realCount === 1 && st.stored === 1 &&
    st.dirty === "是" && /#1/.test(st.selected) && /B$/.test(st.storage);
  check("status: panel matches memory & localStorage", ok, JSON.stringify(st));
  await ctx.close();
}

/* ---------- 12. desktop screenshots in 3 languages ---------- */
for (const lang of ["zh-CN", "en", "ar"]) {
  const { ctx, page } = await newPage(1280, 800);
  await page.getByTestId("language-select").selectOption(lang);
  await page.getByTestId("toolbar").getByRole("button").nth(0).click();
  await page.getByTestId("toolbar").getByRole("button").nth(1).click();
  await page.screenshot({ path: join(SHOTS, `desktop-${lang}.png`), fullPage: true });
  await ctx.close();
}

/* ---------- summary ---------- */
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
server.close();
process.exit(failed.length ? 1 : 0);
