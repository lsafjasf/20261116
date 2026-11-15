import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const PORT = Number(process.env.TEST_PORT || 42627);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ARTIFACTS = new URL("./artifacts/", import.meta.url).pathname;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/home/hj/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome",
  "/home/hj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
].filter(Boolean);

const report = {
  startedAt: new Date().toISOString(),
  url: BASE_URL,
  scenarios: {},
  focusOrder: [],
  screenshots: [],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Test server did not start");
}

function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

function wirePage(page, bucket) {
  page.on("pageerror", (error) => bucket.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") bucket.push(`console: ${message.text()}`);
  });
}

async function openPair(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const errors = [];
  wirePage(pageA, errors);
  wirePage(pageB, errors);
  await pageA.goto(BASE_URL);
  await pageB.goto(BASE_URL);
  await pageA.waitForSelector("#objectList [data-object-id]");
  await pageB.waitForSelector("#objectList [data-object-id]");
  await pageA.waitForFunction(() => document.querySelector("#peerCount")?.textContent.includes("2"));
  await pageB.waitForFunction(() => document.querySelector("#peerCount")?.textContent.includes("2"));
  return { context, pageA, pageB, errors };
}

async function activeSummary(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { tag: "body", id: "", label: "body" };
    const label =
      element.getAttribute("aria-label") ||
      element.labels?.[0]?.textContent?.trim() ||
      element.textContent?.trim() ||
      "";
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      className: element.className || "",
      resolution: element.dataset?.resolution || "",
      conflictId: element.dataset?.conflictId || "",
      label: label.replace(/\s+/g, " ").slice(0, 70),
    };
  });
}

async function tabUntil(page, predicate, limit = 80) {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    const summary = await activeSummary(page);
    if (predicate(summary)) return summary;
  }
  throw new Error(`Tab target not reached after ${limit} presses`);
}

async function focusOrderCheck(page) {
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  const order = [];
  for (let index = 0; index < 24; index += 1) {
    await page.keyboard.press("Tab");
    const summary = await activeSummary(page);
    order.push(summary);
    if (summary.id === "fieldNote") break;
  }
  assert(order[0]?.className.includes("skip-link"), "First Tab stop must be the skip link");
  const ids = order.map((item) => item.id).filter(Boolean);
  for (const required of [
    "exportButton",
    "objectSearch",
    "addObjectButton",
    "fieldTitle",
    "fieldOwner",
    "fieldType",
    "fieldNote",
  ]) {
    assert(ids.includes(required), `Focus order is missing ${required}`);
  }
  const objectIndex = order.findIndex((item) => item.className.includes("object-item"));
  const titleIndex = order.findIndex((item) => item.id === "fieldTitle");
  assert(objectIndex > 0 && objectIndex < titleIndex, "Object list must precede the editor fields");
  report.focusOrder = order;
  return order;
}

async function selectObjectMouse(page, objectId) {
  await page.locator(`[data-object-id="${objectId}"]`).click();
  await page.waitForFunction(
    (id) => document.querySelector(`[data-object-id="${id}"]`)?.getAttribute("aria-current") === "true",
    objectId,
  );
}

async function selectObjectKeyboard(page, objectId) {
  const current = await page.locator('[data-object-id][aria-current="true"]').getAttribute("data-object-id");
  const ids = await page.locator("[data-object-id]").evaluateAll((nodes) =>
    nodes.map((node) => node.dataset.objectId),
  );
  if (current === objectId) {
    await page.keyboard.press("Alt+ArrowDown");
    await page.keyboard.press("Alt+ArrowUp");
  } else {
    const currentIndex = ids.indexOf(current);
    const targetIndex = ids.indexOf(objectId);
    const down = (targetIndex - currentIndex + ids.length) % ids.length;
    const up = (currentIndex - targetIndex + ids.length) % ids.length;
    const key = down <= up ? "Alt+ArrowDown" : "Alt+ArrowUp";
    for (let index = 0; index < Math.min(down, up); index += 1) {
      await page.keyboard.press(key);
    }
  }
  await page.waitForFunction(
    (id) => document.querySelector(`[data-object-id="${id}"]`)?.getAttribute("aria-current") === "true",
    objectId,
  );
}

async function setFieldKeyboard(page, fieldName, value) {
  await tabUntil(page, (active) => active.id === `field${fieldName[0].toUpperCase()}${fieldName.slice(1)}`);
  await page.keyboard.press("Control+A");
  if (value) {
    await page.keyboard.insertText(value);
  } else {
    await page.keyboard.press("Backspace");
  }
}

async function setFieldMouse(page, fieldName, value) {
  const input = page.locator(`[data-field="${fieldName}"]`);
  await input.click();
  await input.fill(value);
}

async function saveMouse(page) {
  await page.locator("#saveButton").click();
}

async function saveKeyboard(page) {
  await page.keyboard.press("Control+s");
}

async function openExportMouse(page) {
  await page.locator("#exportButton").click();
}

async function openExportKeyboard(page) {
  await page.keyboard.press("Alt+e");
}

async function closeExportMouse(page) {
  await page.locator("#closeExportButton").click();
}

async function closeExportKeyboard(page) {
  await page.keyboard.press("Escape");
}

async function waitForRevision(page, minimum) {
  await page.waitForFunction((revision) => {
    const text = document.querySelector("#syncBadgeText")?.textContent || "";
    const match = text.match(/rev\s+(\d+)/);
    return match && Number(match[1]) >= revision;
  }, minimum);
}

async function waitForNoOpenConflict(page) {
  await page.waitForFunction(() => document.querySelectorAll('[data-conflict-card] .status-warn').length === 0);
}

async function readProject(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("localstudio.project.v1")));
}

async function screenshot(page, name) {
  const path = `${ARTIFACTS}${name}`;
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push(path);
  return path;
}

function createAdapter(mode) {
  const keyboard = mode === "keyboard";
  return {
    mode,
    select: keyboard ? selectObjectKeyboard : selectObjectMouse,
    setField: keyboard ? setFieldKeyboard : setFieldMouse,
    save: keyboard ? saveKeyboard : saveMouse,
    openExport: keyboard ? openExportKeyboard : openExportMouse,
    closeExport: keyboard ? closeExportKeyboard : closeExportMouse,
    undo: async (page) => {
      if (keyboard) {
        await page.keyboard.press("Alt+z");
      } else {
        await page.locator("#undoButton").click();
      }
      await page.waitForTimeout(220);
    },
    revert: async (page) => {
      if (keyboard) {
        await tabUntil(page, (active) => active.id === "revertButton");
        await page.keyboard.press("Enter");
      } else {
        await page.locator("#revertButton").click();
      }
      await page.waitForFunction(
        () => !document.querySelector("#revertButton") || document.querySelector("#revertButton").disabled,
      );
    },
  };
}

async function assertValidationFailure(page, adapter) {
  await adapter.setField(page, "title", "");
  await adapter.save(page);
  await page.waitForSelector("#validationSummary:not([hidden])");
  const summary = await page.locator("#validationSummary").textContent();
  const invalid = await page.locator("#fieldTitle").getAttribute("aria-invalid");
  const draftHint = await page.locator("#draftHint").textContent();
  assert(summary.includes("提交失败"), "Validation summary must explain the failure");
  assert(summary.includes("场景标题不能为空"), "Validation summary must name the invalid field");
  assert(invalid === "true", "Invalid title must expose aria-invalid=true");
  assert(draftHint.includes("未提交"), "Invalid submit must retain the uncommitted draft");
  return { summary: summary.trim(), invalid, draftHint: draftHint.trim() };
}

async function resolveConflictMouse(page, resolution) {
  await page.locator(`[data-resolution="${resolution}"]`).first().click();
  await waitForNoOpenConflict(page);
}

async function resolveConflictKeyboard(page, resolution) {
  await tabUntil(page, (active) => active.resolution === resolution && active.conflictId);
  await page.keyboard.press("Enter");
  await waitForNoOpenConflict(page);
}

async function createSameObjectConflict(pageA, pageB, adapter, mode) {
  await adapter.select(pageA, "scene-rain-open");
  await adapter.select(pageB, "scene-rain-open");
  await adapter.setField(pageB, "note", `B 本地草稿 ${mode}`);
  await adapter.setField(pageA, "note", `A 远端提交 ${mode}`);
  await adapter.save(pageA);
  await pageB.waitForFunction(
    (value) =>
      document.querySelector('[data-field="note"]')?.value === value &&
      document.querySelector("#noteDraftState")?.textContent.includes("远端已更新"),
    `B 本地草稿 ${mode}`,
  );
  await adapter.save(pageB);
  await pageB.waitForSelector('[data-conflict-card] .status-warn');
  const conflictText = await pageB.locator('[data-conflict-card]').first().textContent();
  assert(conflictText.includes("scene-rain-open.note"), "Conflict must expose its field path");
  assert(conflictText.includes(`B 本地草稿 ${mode}`), "Conflict must retain the local value");
  assert(conflictText.includes(`A 远端提交 ${mode}`), "Conflict must retain the remote value");
  assert(conflictText.includes("共同基线"), "Conflict must retain the common base value");
  const conflictShot = await screenshot(pageB, `conflict-${mode}.png`);
  if (mode === "keyboard") {
    await resolveConflictKeyboard(pageB, "local");
  } else {
    await resolveConflictMouse(pageB, "local");
  }
  await pageB.waitForFunction(
    (value) => document.querySelector('[data-field="note"]')?.value === value,
    `B 本地草稿 ${mode}`,
  );
  await pageA.waitForFunction(
    (value) => document.querySelector('[data-field="note"]')?.value === value,
    `B 本地草稿 ${mode}`,
  );
  return {
    fieldPath: "scene-rain-open.note",
    localValue: `B 本地草稿 ${mode}`,
    remoteValue: `A 远端提交 ${mode}`,
    screenshot: conflictShot,
  };
}

async function testDraftRecoveryAndUndo(page, adapter, mode, titleToRestore) {
  const draftValue = `刷新保留草稿 ${mode}`;
  await adapter.select(page, "scene-rooftop");
  await adapter.setField(page, "owner", draftValue);
  await page.evaluate(() => window.scrollTo(0, 560));
  await page.waitForTimeout(120);
  const before = {
    selectedId: await page.locator('[data-object-id][aria-current="true"]').getAttribute("data-object-id"),
    scrollY: await page.evaluate(() => Math.round(window.scrollY)),
    draft: draftValue,
  };

  await adapter.openExport(page);
  await page.waitForSelector("#exportDialog[open]");
  const blocked = await page.locator("#exportReadiness").textContent();
  assert(blocked.includes("暂不可导出"), "Export dialog must block with an uncommitted draft");
  const blockedShot = await screenshot(page, `export-blocked-${mode}.png`);
  await adapter.closeExport(page);
  await page.waitForFunction(() => !document.querySelector("#exportDialog")?.open);
  const afterDialogClose = {
    selectedId: await page.locator('[data-object-id][aria-current="true"]').getAttribute("data-object-id"),
    scrollY: await page.evaluate(() => Math.round(window.scrollY)),
    draft: await page.locator('[data-field="owner"]').inputValue(),
  };
  assert(
    afterDialogClose.draft === draftValue,
    "Closing the export dialog must preserve the draft",
  );
  assert(
    afterDialogClose.selectedId === before.selectedId,
    "Closing the export dialog must preserve the selected object",
  );
  assert(
    afterDialogClose.scrollY >= before.scrollY - 80,
    "Closing the export dialog must preserve the scroll position",
  );

  await page.reload();
  await page.waitForSelector("#objectList [data-object-id]");
  await page.waitForTimeout(250);
  const afterRefresh = {
    selectedId: await page.locator('[data-object-id][aria-current="true"]').getAttribute("data-object-id"),
    scrollY: await page.evaluate(() => Math.round(window.scrollY)),
    draft: await page.locator('[data-field="owner"]').inputValue(),
  };
  assert(afterRefresh.draft === draftValue, "Refresh must preserve the uncommitted draft");
  assert(afterRefresh.selectedId === before.selectedId, "Refresh must preserve the selected object");
  assert(afterRefresh.scrollY >= before.scrollY - 80, "Refresh must restore the scroll position");

  await adapter.select(page, "scene-rain-open");
  const beforeUndo = {
    selectedId: await page.locator('[data-object-id][aria-current="true"]').getAttribute("data-object-id"),
    scrollY: await page.evaluate(() => Math.round(window.scrollY)),
  };
  await adapter.undo(page);
  assert(
    (await page.locator("#inspectDrafts").textContent()).includes("1 个字段"),
    "Undo must retain the separately stored uncommitted draft",
  );
  assert(
    (await page.locator('[data-object-id][aria-current="true"]').getAttribute("data-object-id")) ===
      beforeUndo.selectedId,
    "Undo must preserve the selected object",
  );
  assert(
    (await page.evaluate(() => Math.round(window.scrollY))) >= beforeUndo.scrollY - 100,
    "Undo must preserve the scroll position",
  );

  await adapter.select(page, "scene-rooftop");
  assert(
    (await page.locator('[data-field="owner"]').inputValue()) === draftValue,
    "The uncommitted draft must still be visible after returning to its object",
  );
  await adapter.revert(page);
  await adapter.select(page, "scene-rooftop");
  await adapter.setField(page, "title", titleToRestore);
  await adapter.save(page);
  await page.waitForFunction(
    (title) => {
      const project = JSON.parse(localStorage.getItem("localstudio.project.v1") || "null");
      return project?.objects.find((object) => object.id === "scene-rooftop")
        ?.fields.title.value === title;
    },
    titleToRestore,
  );
  return {
    before,
    afterDialogClose,
    afterRefresh,
    beforeUndo,
    blockedMessage: blocked.trim(),
    blockedScreenshot: blockedShot,
  };
}

async function testRecoveryFailure(page) {
  const tabId = await page.evaluate(() => document.body.dataset.tabId);
  const invalid = '{"selectedId":"scene-rooftop","drafts":';
  await page.evaluate(
    ({ id, raw }) =>
      localStorage.setItem("test:corrupt-session-once", JSON.stringify({ id, raw })),
    { id: tabId, raw: invalid },
  );
  await page.addInitScript(() => {
    const pending = localStorage.getItem("test:corrupt-session-once");
    if (!pending) return;
    const { id, raw } = JSON.parse(pending);
    sessionStorage.setItem(`localstudio.session.v1:${id}`, raw);
    localStorage.removeItem("test:corrupt-session-once");
  });
  await page.reload();
  await page.waitForSelector("#storageBanner:not([hidden])");
  const banner = await page.locator("#storageBanner").textContent();
  const raw = await page.locator("#storageBanner .recovery-raw").textContent();
  assert(banner.includes("恢复失败"), "Recovery failure must be clearly announced");
  assert(raw.includes('"drafts"'), "Recovery failure must keep the unreadable snapshot readable");
  return { banner: banner.replace(/\s+/g, " ").trim(), rawSnapshot: raw.trim() };
}

async function testConsistentExport(page, adapter, mode, expected) {
  await page.waitForFunction(
    () => !document.querySelector("#confirmExportButton")?.disabled,
    null,
    { timeout: 4_000 },
  ).catch(() => {});
  await adapter.openExport(page);
  await page.waitForSelector("#exportDialog[open]");
  await page.waitForFunction(() => !document.querySelector("#confirmExportButton")?.disabled);
  const readiness = await page.locator("#exportReadiness").textContent();
  assert(readiness.includes("检查通过"), "Export must show a consistent-snapshot check");
  const exportShot = await screenshot(page, `export-ready-${mode}.png`);
  const downloadPromise = page.waitForEvent("download");
  if (adapter.mode === "keyboard") {
    await page.keyboard.press("Enter");
  } else {
    await page.locator("#confirmExportButton").click();
  }
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const snapshot = JSON.parse(await readFile(downloadPath, "utf8"));
  const snapshotArtifact = `${ARTIFACTS}snapshot-${mode}.json`;
  await writeFile(snapshotArtifact, JSON.stringify(snapshot, null, 2));
  assert(snapshot.schema === "localstudio.consistent-snapshot.v1", "Unexpected snapshot schema");
  assert(snapshot.project.revision === expected.revision, "Snapshot revision must match storage");
  assert(snapshot.project.checksum === expected.checksum, "Snapshot checksum must match storage");
  assert(snapshot.consistency.activeTabs === 2, "Snapshot must include both active tabs");
  assert(
    snapshot.consistency.peerRevisions.every(
      (peer) => peer.revision === snapshot.project.revision && peer.checksum === snapshot.project.checksum,
    ),
    "All peer revisions in the snapshot must match",
  );
  assert(
    snapshot.conflictTrace.some(
      (conflict) =>
        conflict.compound === "scene-rain-open.note" &&
        conflict.status === "resolved" &&
        conflict.resolution === "local",
    ),
    "Snapshot must retain the resolved conflict trace",
  );
  const titles = snapshot.objects.map((object) => object.fields.title.value);
  assert(titles.includes(expected.titleA), "Snapshot must contain the first tab edit");
  assert(titles.includes(expected.titleB), "Snapshot must contain the second tab edit");
  await page.waitForFunction(() => !document.querySelector("#confirmExportButton")?.disabled);
  await adapter.closeExport(page);
  return {
    filename: download.suggestedFilename(),
    revision: snapshot.project.revision,
    checksum: snapshot.project.checksum,
    activeTabs: snapshot.consistency.activeTabs,
    objectTitles: titles,
    readiness: readiness.trim(),
    screenshot: exportShot,
    snapshotArtifact,
  };
}

async function runScenario(browser, mode) {
  const adapter = createAdapter(mode);
  const startedAt = new Date().toISOString();
  const { context, pageA, pageB, errors } = await openPair(browser);
  const scenario = {
    mode,
    startedAt,
    checks: {},
    errors,
  };
  try {
    const focus = await focusOrderCheck(pageB);
    scenario.checks.focusOrder = focus.map((item) => `${item.id || item.className || item.tag}:${item.label}`);
    assert(
      (await pageB.locator("#inspectSync").textContent()).includes("输入 = 存储 = 渲染"),
      "Initial state inspector must report input, storage and render alignment",
    );

    await adapter.select(pageA, "scene-rain-open");
    scenario.checks.validation = await assertValidationFailure(pageA, adapter);
    const titleA = `雨夜开场 · ${mode} A`;
    await adapter.setField(pageA, "title", titleA);
    await adapter.save(pageA);
    await pageB.waitForFunction(
      (title) => document.body.innerText.includes(title),
      titleA,
    );

    await adapter.select(pageB, "scene-rooftop");
    const titleB = `天台追逐 · ${mode} B`;
    await adapter.setField(pageB, "title", titleB);
    await adapter.save(pageB);
    await pageA.waitForFunction(
      (title) => document.body.innerText.includes(title),
      titleB,
    );
    scenario.checks.differentObjects = { titleA, titleB };

    scenario.checks.conflict = await createSameObjectConflict(pageA, pageB, adapter, mode);
    scenario.checks.draftRecovery = await testDraftRecoveryAndUndo(pageB, adapter, mode, titleB);
    scenario.checks.recoveryFailure = await testRecoveryFailure(pageB);

    await pageA.waitForFunction(() => document.querySelector("#peerCount")?.textContent.includes("2"));
    await pageB.waitForFunction(
      () => /已同步 rev/.test(document.querySelector("#syncBadgeText")?.textContent || ""),
    );
    const stored = await readProject(pageA);
    scenario.checks.export = await testConsistentExport(pageA, adapter, mode, {
      revision: stored.revision,
      checksum: stored.checksum,
      titleA,
      titleB,
    });

    await pageA.waitForFunction(() =>
      [...document.querySelectorAll(".lease-badge")].every((node) =>
        node.textContent.includes("2"),
      ),
    );
    const beforeClose = {
      peers: await pageA.locator("#peerCount").textContent(),
      leases: await pageA.locator(".lease-badge").allTextContents(),
    };
    await pageB.close();
    await pageA.waitForFunction(
      () => document.querySelector("#peerCount")?.textContent.includes("1"),
      null,
      { timeout: 5_000 },
    );
    await pageA.waitForFunction(
      () =>
        [...document.querySelectorAll(".lease-badge")].every((node) =>
          node.textContent.includes("1"),
        ),
      null,
      { timeout: 5_000 },
    );
    const ownTabId = await pageA.evaluate(() => document.body.dataset.tabId);
    const afterClose = await pageA.evaluate(() => {
      const project = JSON.parse(localStorage.getItem("localstudio.project.v1"));
      return {
        peers: document.querySelector("#peerCount")?.textContent,
        leases: [...document.querySelectorAll(".lease-badge")].map((node) => node.textContent),
        resources: project.resources.map((resource) => resource.name),
        images: [...document.querySelectorAll(".resource-thumb")].map((image) => ({
          src: image.getAttribute("src"),
          loaded: image.complete && image.naturalWidth > 0,
        })),
        claimTabs: Object.keys(localStorage)
          .filter((key) => key.startsWith("localstudio.claim.v1:"))
          .map((key) => key.slice("localstudio.claim.v1:".length)),
      };
    });
    assert(afterClose.resources.length === 2, "Closing one tab must not delete project resources");
    assert(afterClose.images.every((image) => image.loaded), "Remaining resources must stay readable");
    assert(new Set(afterClose.claimTabs).size === 1, "Only the remaining tab may hold leases");
    assert(afterClose.claimTabs.every((id) => id === ownTabId), "Leases must belong to the remaining tab");
    scenario.checks.resources = { beforeClose, afterClose };
    scenario.checks.finalState = await pageA.evaluate(() => ({
      sync: document.querySelector("#inspectSync")?.textContent,
      store: document.querySelector("#inspectStore")?.textContent,
      render: document.querySelector("#inspectRender")?.textContent,
      focusOrder: document.querySelector("#inspectFocus")?.textContent,
    }));
    scenario.screenshot = await screenshot(pageA, `final-${mode}.png`);
    assert(errors.length === 0, `Browser errors in ${mode} scenario: ${errors.join(" | ")}`);
    scenario.ok = true;
  } catch (error) {
    scenario.ok = false;
    scenario.failure = error.stack || error.message;
    try {
      scenario.failureScreenshot = await screenshot(pageA, `failure-${mode}.png`);
    } catch {
      // The page may already be closed.
    }
    throw error;
  } finally {
    scenario.finishedAt = new Date().toISOString();
    report.scenarios[mode] = scenario;
    await context.close().catch(() => {});
  }
  return scenario;
}

async function main() {
  await mkdir(ARTIFACTS, { recursive: true });
  const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  assert(chromePath, "No Chromium executable found");
  const server = startServer();
  let browser;
  try {
    await waitForServer();
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    await runScenario(browser, "mouse");
    await runScenario(browser, "keyboard");
    report.ok = true;
    report.finishedAt = new Date().toISOString();
    await writeFile(`${ARTIFACTS}e2e-report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ok: true,
      scenarios: Object.fromEntries(
        Object.entries(report.scenarios).map(([mode, scenario]) => [
          mode,
          {
            export: scenario.checks.export,
            conflict: scenario.checks.conflict,
            resources: scenario.checks.resources?.afterClose,
          },
        ]),
      ),
      report: `${ARTIFACTS}e2e-report.json`,
    }, null, 2));
  } catch (error) {
    report.ok = false;
    report.finishedAt = new Date().toISOString();
    report.failure = error.stack || error.message;
    await writeFile(`${ARTIFACTS}e2e-report.json`, JSON.stringify(report, null, 2));
    console.error(error.stack || error);
    console.error(server.output());
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    server.child.kill("SIGTERM");
  }
}

main();
