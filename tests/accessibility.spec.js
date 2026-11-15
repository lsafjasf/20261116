const { test, expect } = require("@playwright/test");

const KEY_PATH = [
  "ArrowRight",
  "ArrowDown",
  "ArrowDown",
  "ArrowRight",
  "ArrowRight",
  "ArrowRight",
  "ArrowDown",
  "ArrowDown",
  "ArrowDown",
];

async function resetApp(page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__echoRelay));
  await page.waitForTimeout(120);
}

async function stateOf(page) {
  return page.evaluate(() => window.__echoRelay.getState());
}

async function cellPoint(page, coordinate) {
  const box = await page.locator("#game-canvas").boundingBox();
  const size = box.width;
  const padding = Math.max(12, size * 0.032);
  const gap = Math.max(6, size * 0.014);
  const cell = (size - padding * 2 - gap * 4) / 5;
  const col = coordinate.charCodeAt(0) - 65;
  const row = Number(coordinate[1]) - 1;
  return {
    x: box.x + padding + col * (cell + gap) + cell / 2,
    y: box.y + padding + row * (cell + gap) + cell / 2,
  };
}

async function clickCell(page, coordinate) {
  const box = await page.locator("#game-canvas").boundingBox();
  const size = box.width;
  const padding = Math.max(12, size * 0.032);
  const gap = Math.max(6, size * 0.014);
  const cell = (size - padding * 2 - gap * 4) / 5;
  const col = coordinate.charCodeAt(0) - 65;
  const row = Number(coordinate[1]) - 1;
  await page.locator("#game-canvas").click({
    position: {
      x: padding + col * (cell + gap) + cell / 2,
      y: padding + row * (cell + gap) + cell / 2,
    },
  });
}

async function expectFailure(page) {
  await expect(page.locator("#result-text")).toContainText("移动失败：B3 是脉冲危险区");
  await expect(page.locator("#semantic-position")).toContainText("玩家当前位置：B2");
  await expect(page.locator("#semantic-result")).toContainText("B3 是脉冲危险区");
  await expect(page.locator("#live-assertive")).toContainText(
    "移动失败：B3 是脉冲危险区，玩家仍在 B2",
  );
  await expect(page.locator("#readout-danger")).toContainText("B3");
}

async function expectFinished(page) {
  const state = await stateOf(page);
  expect(state.game.status).toBe("won");
  expect(state.game.hasKey).toBe(true);
  await expect(page.locator("#status-badge")).toHaveText("任务已完成");
  await expect(page.locator("#semantic-status")).toContainText("任务完成");
  await expect(page.locator("#semantic-position")).toContainText("玩家当前位置：E5");
  await expect(page.locator("#semantic-objective")).toContainText("E5 出口");
  await expect(page.locator("#state-pin")).toContainText('"position": "E5"');
}

test("keyboard-only game reports position, danger, failure and completion", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await resetApp(page);

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator("#game-canvas")).toBeFocused();

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectFailure(page);

  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#semantic-position")).toContainText("C2");
  await expect(page.locator("#readout-objective")).toContainText("E5");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  await expectFinished(page);
  await expect(page.locator("#live-polite")).toContainText("任务完成");
  const before = await page.evaluate(() => ({ ...window.__echoRelay.metrics }));
  await page.waitForTimeout(350);
  const after = await page.evaluate(() => ({ ...window.__echoRelay.metrics }));
  expect(after.frames).toBeGreaterThan(before.frames);
  expect(after.semanticRenders).toBe(before.semanticRenders);
  expect(errors).toEqual([]);
});

test("mouse completes the same task and exposes the same readable failure", async ({ page }) => {
  await resetApp(page);
  await clickCell(page, "B1");
  await clickCell(page, "B2");
  await clickCell(page, "B3");
  await expectFailure(page);

  await clickCell(page, "C2");
  await clickCell(page, "D2");
  await clickCell(page, "E2");
  await clickCell(page, "E3");
  await clickCell(page, "E4");
  await clickCell(page, "E5");
  await expectFinished(page);
  await expect(page.locator("#sync-input")).toContainText("鼠标");
  await expect(page.locator("#live-polite")).toContainText("任务完成");
});

test("focus order is logical and the dialog restores focus", async ({ page }) => {
  await resetApp(page);
  const focused = [];
  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.press("Tab");
    focused.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        return active.id || active.className || active.tagName;
      }),
    );
  }
  expect(focused).toEqual([
    "skip-link",
    "brand",
    "game-canvas",
    "move-button move-up",
    "move-button move-left",
    "move-button move-down",
    "move-button move-right",
    "open-cell",
    "undo",
    "draft-note",
    "submit-note",
    "log-scroll",
    "state-pin",
    "reset-game",
  ]);

  await page.locator("#game-canvas").focus();
  await expect(page.locator("#game-canvas")).toHaveAttribute("aria-label", /玩家在 A1/);
  await page.locator("#open-cell").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#close-cell")).toBeFocused();
  await expect(page.locator("#cell-dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("#dialog-done")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#cell-dialog")).not.toBeVisible();
  await expect(page.locator("#open-cell")).toBeFocused();
});

test("draft, selection and both scroll positions survive close, undo and refresh", async ({
  page,
}) => {
  await resetApp(page);
  await page.locator("#game-canvas").focus();
  for (const key of KEY_PATH) {
    await page.keyboard.press(key);
  }
  await expectFinished(page);

  await clickCell(page, "A5");
  const draft = "未提交交接：沿南侧避开 C4，保留 E4 到 E5 的退路。";
  await page.locator("#draft-note").fill(draft);
  await page.waitForTimeout(260);
  await page.locator("#log-scroll").evaluate((element) => {
    element.scrollTop = 80;
  });
  await page.evaluate(() => window.scrollTo(0, 460));
  await page.waitForTimeout(420);

  const beforeClose = await stateOf(page);
  expect(beforeClose.draft.text).toBe(draft);
  expect(beforeClose.game.selected).toEqual({ x: 0, y: 4 });
  expect(beforeClose.ui.scrollY).toBeGreaterThan(300);
  expect(beforeClose.ui.logScroll).toBeGreaterThan(0);

  await page.evaluate(() => document.querySelector("#open-cell").click());
  await expect(page.locator("#cell-dialog")).toBeVisible();
  await expect(page.locator("#cell-dialog-title")).toContainText("A5");
  await page.keyboard.press("Escape");
  await expect(page.locator("#cell-dialog")).not.toBeVisible();
  await page.waitForTimeout(120);

  const afterClose = await stateOf(page);
  expect(afterClose.draft.text).toBe(draft);
  expect(afterClose.game.selected).toEqual({ x: 0, y: 4 });
  expect(afterClose.ui.scrollY).toBe(beforeClose.ui.scrollY);
  expect(afterClose.ui.logScroll).toBe(beforeClose.ui.logScroll);

  await page.evaluate(() => document.querySelector("#undo").click());
  await page.waitForTimeout(160);
  const afterUndo = await stateOf(page);
  expect(afterUndo.draft.text).toBe(draft);
  expect(afterUndo.game.selected).toEqual({ x: 0, y: 4 });
  expect(afterUndo.ui.scrollY).toBe(beforeClose.ui.scrollY);
  expect(afterUndo.ui.logScroll).toBe(beforeClose.ui.logScroll);
  expect(afterUndo.game.player).toEqual({ x: 4, y: 3 });
  expect(afterUndo.game.status).toBe("playing");

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__echoRelay));
  await page.waitForTimeout(500);
  const restored = await stateOf(page);
  expect(restored.draft.text).toBe(draft);
  expect(restored.game.selected).toEqual({ x: 0, y: 4 });
  expect(restored.game.player).toEqual({ x: 4, y: 3 });
  expect(restored.ui.scrollY).toBe(beforeClose.ui.scrollY);
  expect(restored.ui.logScroll).toBe(beforeClose.ui.logScroll);
  await expect(page.locator("#draft-note")).toHaveValue(draft);
  await expect(page.locator("#selected-name")).toContainText("A5");
  await expect(page.locator("#state-pin")).toContainText('"selected": "A5"');
});

test("backup recovery and total restore failure keep readable snapshots", async ({ page }) => {
  await resetApp(page);
  await page.locator("#game-canvas").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.locator("#draft-note").fill("快照中的未提交备注");
  await page.waitForTimeout(300);

  const stored = await stateOf(page);
  expect(stored.game.hasKey).toBe(true);
  const keys = await page.evaluate(() => window.__echoRelay.getStorageKeys());
  await page.evaluate(() => window.__echoRelay.setPersistencePaused(true));
  await page.evaluate((mainKey) => {
    localStorage.setItem(mainKey, "{broken-json");
  }, keys.main);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__echoRelay));
  await page.waitForTimeout(450);

  await expect(page.locator("#restore-banner")).toBeVisible();
  await expect(page.locator("#restore-banner")).toContainText("主存档恢复失败");
  await expect(page.locator("#restore-banner")).toContainText("可读快照");
  const recovered = await stateOf(page);
  expect(recovered.game.hasKey).toBe(true);
  expect(recovered.game.player).toEqual({ x: 2, y: 1 });
  expect(recovered.draft.text).toBe("快照中的未提交备注");

  await page.evaluate((storageKeys) => {
    window.__echoRelay.setPersistencePaused(true);
    localStorage.setItem(storageKeys.main, "not-json");
    localStorage.setItem(storageKeys.backup, "also-not-json");
  }, keys);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__echoRelay));
  await page.waitForTimeout(450);

  await expect(page.locator("#restore-banner")).toBeVisible();
  await expect(page.locator("#restore-banner")).toContainText("存档恢复失败");
  await expect(page.locator("#restore-banner")).toContainText("可读快照");
  await expect(page.locator("#state-pin")).toContainText('"position": "A1"');
  await expect(page.locator("#semantic-position")).toContainText("玩家当前位置：A1");
  await expect(page.locator("#state-pin")).toContainText('"draft": "空"');
});
