import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startServer } from "./serve.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "artifacts", "screenshots");
const ARTIFACTS = path.join(ROOT, "artifacts");
const VIEWPORT = { width: 1440, height: 1000 };
const BASE = { x: 252, y: 438 };
const POINTS = [
  { name: "低台", x: 650, y: 438 },
  { name: "断桥", x: 672, y: 306 },
  { name: "鹰巢", x: 696, y: 178 },
];

fs.mkdirSync(SHOTS, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function near(left, right, tolerance = 2) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

async function openFreshPage(browser, serverUrl) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.goto(serverUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  return { context, page, errors };
}

async function gameView(page) {
  return page.evaluate(() => window.__WINCH_GAME__.getView());
}

async function servo(page, targetX, targetY, tolerance = 15, timeout = 15000) {
  const startedAt = Date.now();
  let horizontal = null;
  let vertical = null;
  while (Date.now() - startedAt < timeout) {
    const view = await gameView(page);
    if (view.phase !== "active") {
      throw new Error(`servo aborted in phase ${view.phase}`);
    }
    const dx = targetX - view.x;
    const dy = targetY - view.y;
    if (dx > 12) {
      if (horizontal !== "d") {
        if (horizontal) await page.keyboard.up(horizontal);
        await page.keyboard.down("d");
        horizontal = "d";
      }
    } else if (dx < -12) {
      if (horizontal !== "a") {
        if (horizontal) await page.keyboard.up(horizontal);
        await page.keyboard.down("a");
        horizontal = "a";
      }
    } else if (horizontal) {
      await page.keyboard.up(horizontal);
      horizontal = null;
    }
    if (dy > 10) {
      if (vertical !== "s") {
        if (vertical) await page.keyboard.up(vertical);
        await page.keyboard.down("s");
        vertical = "s";
      }
    } else if (dy < -10) {
      if (vertical !== "w") {
        if (vertical) await page.keyboard.up(vertical);
        await page.keyboard.down("w");
        vertical = "w";
      }
    } else if (vertical) {
      await page.keyboard.up(vertical);
      vertical = null;
    }
    await page.waitForTimeout(22);
    const next = await gameView(page);
    if (Math.abs(next.x - targetX) < tolerance &&
      Math.abs(next.y - targetY) < tolerance &&
      Math.hypot(next.vx, next.vy) < 28) {
      break;
    }
  }
  if (horizontal) await page.keyboard.up(horizontal);
  if (vertical) await page.keyboard.up(vertical);
  await page.waitForTimeout(90);
}

async function grab(page, point) {
  await servo(page, point.x - 14, point.y);
  await page.keyboard.down("Space");
  const startedAt = Date.now();
  let view = await gameView(page);
  while (Date.now() - startedAt < 5000 && !view.carrying) {
    await page.waitForTimeout(40);
    view = await gameView(page);
  }
  await page.keyboard.up("Space");
  return view;
}

async function returnToDock(page, expectedRescued) {
  await servo(page, BASE.x + 10, BASE.y);
  await page.keyboard.down("Space");
  const startedAt = Date.now();
  let view = await gameView(page);
  while (Date.now() - startedAt < 5000 && view.rescued < expectedRescued) {
    await page.waitForTimeout(40);
    view = await gameView(page);
  }
  await page.keyboard.up("Space");
  return view;
}

function sessionSnapshot(view) {
  return {
    leftTension: view.leftTension,
    rightTension: view.rightTension,
    durability: view.durability,
    rescued: view.rescued,
    phase: view.phase,
  };
}

async function testSuccessfulMission(browser, serverUrl) {
  const { context, page, errors } = await openFreshPage(browser, serverUrl);
  for (let index = 0; index < POINTS.length; index += 1) {
    const point = POINTS[index];
    const grabbed = await grab(page, point);
    assert(grabbed.carrying, `Failed to grab ${point.name}: ${JSON.stringify(grabbed)}`);
    const returned = await returnToDock(page, index + 1);
    assert(
      returned.rescued === index + 1,
      `Failed to unload ${point.name}: ${JSON.stringify(returned)}`,
    );
  }
  await page.waitForTimeout(900);
  const completed = await gameView(page);
  const events = await page.evaluate(() => window.__WINCH_GAME__.getEvents());
  const audio = await page.evaluate(() => window.__WINCH_GAME__.getAudioState());
  assert(completed.phase === "complete", "Success mission did not complete");
  assert(completed.rescued === 3, "Success mission did not rescue all three");
  assert(completed.durability > 0, "Success mission lost all durability");
  assert(events.filter((event) => event.type === "GRAB").length === 3, "Missing grab events");
  assert(events.filter((event) => event.type === "MISSION_COMPLETE").length === 1,
    "Missing mission complete event");
  assert(audio.voices === 2, "Two Web Audio tension voices were not created");
  assert(audio.leftFrequency !== audio.rightFrequency, "Audio voices are not distinct");

  const beforeReload = await page.evaluate(() => ({
    view: window.__WINCH_GAME__.getView(),
    dom: {
      left: document.querySelector("#leftTensionValue").textContent,
      right: document.querySelector("#rightTensionValue").textContent,
      durability: document.querySelector("#durabilityValue").textContent,
      progress: document.querySelector("#progressValue").textContent,
    },
  }));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(100);
  const afterReload = await page.evaluate(() => ({
    view: window.__WINCH_GAME__.getView(),
    restored: document.body.dataset.restored,
    dom: {
      left: document.querySelector("#leftTensionValue").textContent,
      right: document.querySelector("#rightTensionValue").textContent,
      durability: document.querySelector("#durabilityValue").textContent,
      progress: document.querySelector("#progressValue").textContent,
    },
  }));
  assert(afterReload.restored === "true", "Completed save was not restored");
  assert(afterReload.view.phase === "complete", "Completed phase was not restored");
  assert(afterReload.view.rescued === 3, "Rescued progress was not restored");
  assert(afterReload.view.durability === beforeReload.view.durability,
    "Durability changed after reload");
  assert(afterReload.dom.progress === "3", "DOM progress was not restored");
  assert(afterReload.dom.durability === beforeReload.dom.durability,
    "DOM durability was not restored");
  assert(near(afterReload.view.leftTension, beforeReload.view.leftTension, 0.01),
    "Left tension was not restored");
  assert(near(afterReload.view.rightTension, beforeReload.view.rightTension, 0.01),
    "Right tension was not restored");
  assert(errors.length === 0, `Success page errors: ${errors.join(" | ")}`);

  await page.screenshot({ path: path.join(SHOTS, "success.png"), fullPage: true });
  const result = {
    phase: completed.phase,
    rescued: completed.rescued,
    durability: completed.durability,
    timelineFrames: await page.evaluate(() => window.__WINCH_GAME__.getTimeline().length),
    events: events.length,
    audio,
    beforeReload: sessionSnapshot(beforeReload.view),
    afterReload: sessionSnapshot(afterReload.view),
  };
  await context.close();
  return result;
}

async function testFailureAndConflict(browser, serverUrl) {
  const { context, page, errors } = await openFreshPage(browser, serverUrl);
  await page.keyboard.down("d");
  await page.waitForTimeout(2400);
  await page.keyboard.down("s");
  await page.waitForTimeout(110);
  await page.keyboard.up("s");
  await page.waitForTimeout(450);
  await page.keyboard.up("d");
  await page.waitForTimeout(20);
  await page.keyboard.down("d");
  const startedAt = Date.now();
  let view = await gameView(page);
  while (Date.now() - startedAt < 12000 && view.phase === "active") {
    await page.waitForTimeout(100);
    view = await gameView(page);
  }
  await page.keyboard.up("d");
  await page.waitForTimeout(500);
  view = await gameView(page);
  const events = await page.evaluate(() => window.__WINCH_GAME__.getEvents());
  const collisions = events.filter((event) => event.type === "COLLISION");
  const conflict = collisions.find((event) => event.conflict);
  const displayedConflict = collisions.filter((event) => event.conflict).at(-1);
  assert(view.phase === "failed", "Failure mission did not fail");
  assert(view.durability === 0, "Failure mission did not reach zero durability");
  assert(collisions.length >= 1, "No collision was recorded");
  assert(conflict, "No action-order conflict was recorded");
  assert(conflict.position, "Conflict is missing object position");
  assert(conflict.orderText.includes("P1") && conflict.orderText.includes("P2"),
    "Conflict does not include both players");
  const conflictDom = await page.locator("#conflictList").textContent();
  assert(conflictDom.includes("吊篮"), "Conflict UI does not show basket object");
  assert(
    conflictDom.includes(Number(displayedConflict.position.x).toFixed(1)),
    `Conflict UI lacks exact x position: expected ${displayedConflict.position.x}, ` +
      `got ${JSON.stringify(conflictDom)}`,
  );
  assert(errors.length === 0, `Failure page errors: ${errors.join(" | ")}`);
  await page.screenshot({ path: path.join(SHOTS, "failure.png"), fullPage: true });
  const result = {
    phase: view.phase,
    durability: view.durability,
    collisions: collisions.length,
    conflict: {
      time: conflict.t,
      order: conflict.orderText,
      position: conflict.position,
    },
  };
  await context.close();
  return result;
}

async function testProtectionAndRecovery(browser, serverUrl) {
  const { context, page, errors } = await openFreshPage(browser, serverUrl);
  const firstGrab = await grab(page, POINTS[0]);
  assert(firstGrab.carrying, "Recovery setup failed to grab first survivor");
  const firstReturn = await returnToDock(page, 1);
  assert(firstReturn.rescued === 1, "Recovery setup failed to return first survivor");
  await page.waitForTimeout(1000);

  const beforeReload = await page.evaluate(() => ({
    view: window.__WINCH_GAME__.getView(),
    dom: {
      left: document.querySelector("#leftTensionValue").textContent,
      right: document.querySelector("#rightTensionValue").textContent,
      durability: document.querySelector("#durabilityValue").textContent,
      progress: document.querySelector("#progressValue").textContent,
    },
  }));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(120);
  const afterReload = await page.evaluate(() => ({
    view: window.__WINCH_GAME__.getView(),
    restored: document.body.dataset.restored,
    dom: {
      left: document.querySelector("#leftTensionValue").textContent,
      right: document.querySelector("#rightTensionValue").textContent,
      durability: document.querySelector("#durabilityValue").textContent,
      progress: document.querySelector("#progressValue").textContent,
    },
  }));
  assert(afterReload.restored === "true", "Partial save was not restored");
  assert(afterReload.view.rescued === 1, "Mission progress was not restored");
  assert(afterReload.dom.progress === "1", "DOM mission progress was not restored");
  assert(afterReload.view.durability === beforeReload.view.durability,
    "Durability was not restored");
  assert(afterReload.dom.durability === beforeReload.dom.durability,
    "DOM durability was not restored");
  assert(near(afterReload.view.leftTension, beforeReload.view.leftTension),
    "Left gauge was not restored");
  assert(near(afterReload.view.rightTension, beforeReload.view.rightTension),
    "Right gauge was not restored");
  await page.screenshot({ path: path.join(SHOTS, "recovery.png"), fullPage: true });

  await page.click("#disconnectTest");
  await page.waitForTimeout(250);
  const protectedState = await gameView(page);
  const blockedStart = { x: protectedState.x, y: protectedState.y };
  await page.keyboard.down("d");
  await page.keyboard.down("w");
  await page.waitForTimeout(500);
  await page.keyboard.up("d");
  await page.keyboard.up("w");
  await page.waitForTimeout(100);
  const blockedEnd = await gameView(page);
  assert(protectedState.phase === "protected", "Disconnect did not enter protected state");
  assert(protectedState.leftTension > 0, "Surviving cable has no tension");
  assert(protectedState.rightTension === 0, "Severed cable tension is not zero");
  assert(protectedState.leftWinch === "brake", "Surviving winch is not braked");
  assert(protectedState.rightWinch === "severed", "Severed winch state is missing");
  assert(protectedState.safety.locked === true, "Safety rope did not lock");
  assert(blockedEnd.x === blockedStart.x && blockedEnd.y === blockedStart.y,
    "Player input moved the basket while protected");
  assert(errors.length === 0, `Protection page errors: ${errors.join(" | ")}`);
  await page.screenshot({ path: path.join(SHOTS, "protection.png"), fullPage: true });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(120);
  const protectedReload = await page.evaluate(() => ({
    view: window.__WINCH_GAME__.getView(),
    restored: document.body.dataset.restored,
    bannerHidden: document.querySelector("#protectionBanner").hidden,
    bannerTitle: document.querySelector("#protectionTitle").textContent,
    dom: {
      left: document.querySelector("#leftTensionValue").textContent,
      right: document.querySelector("#rightTensionValue").textContent,
      durability: document.querySelector("#durabilityValue").textContent,
      progress: document.querySelector("#progressValue").textContent,
    },
  }));
  assert(protectedReload.restored === "true", "Protection save was not restored");
  assert(protectedReload.view.phase === "protected", "Protection phase was not restored");
  assert(protectedReload.view.rightTension === 0, "Restored severed tension is not zero");
  assert(protectedReload.view.leftWinch === "brake", "Restored surviving winch is not braked");
  assert(protectedReload.view.rightWinch === "severed", "Restored severed state is missing");
  assert(protectedReload.view.safety.locked === true, "Restored safety rope is not locked");
  assert(protectedReload.view.rescued === 1, "Progress was lost after protection reload");
  assert(protectedReload.dom.progress === "1", "DOM progress was lost after protection reload");
  assert(protectedReload.bannerHidden === false, "Protection banner is hidden after reload");
  assert(protectedReload.bannerTitle.includes("右侧断索"), "Protection banner title is wrong");
  assert(errors.length === 0, `Protection reload errors: ${errors.join(" | ")}`);
  await page.screenshot({ path: path.join(SHOTS, "protection-reload.png"), fullPage: true });

  const result = {
    beforeReload: sessionSnapshot(beforeReload.view),
    afterReload: sessionSnapshot(afterReload.view),
    protection: {
      phase: protectedState.phase,
      side: protectedState.protection.side,
      leftTension: protectedState.leftTension,
      rightTension: protectedState.rightTension,
      leftWinch: protectedState.leftWinch,
      rightWinch: protectedState.rightWinch,
      safetyLocked: protectedState.safety.locked,
      inputFrozen: blockedEnd.x === blockedStart.x && blockedEnd.y === blockedStart.y,
    },
    afterProtectionReload: {
      phase: protectedReload.view.phase,
      leftTension: protectedReload.view.leftTension,
      rightTension: protectedReload.view.rightTension,
      durability: protectedReload.view.durability,
      rescued: protectedReload.view.rescued,
      restored: protectedReload.restored,
    },
  };
  await context.close();
  return result;
}

async function testCompleteReplay(browser, serverUrl) {
  const { context, page, errors } = await openFreshPage(browser, serverUrl);
  await page.waitForFunction(
    () => !document.querySelector("#loadDemoReplay").disabled,
    null,
    { timeout: 15000 },
  );
  await page.selectOption("#replaySpeed", "4");
  await page.click("#loadDemoReplay");
  await page.waitForTimeout(1400);
  await page.click("#replayToggle");
  const paused = await page.evaluate(() => ({
    audit: window.__WINCH_GAME__.getReplayAudit(),
    proof: document.querySelector("#replayProof").textContent,
    time: document.querySelector("#replayTime").textContent,
    liveHash: window.__WINCH_GAME__.getLiveFinalHash(),
  }));
  await page.waitForTimeout(600);
  const pausedLater = await page.evaluate(() => ({
    audit: window.__WINCH_GAME__.getReplayAudit(),
    time: document.querySelector("#replayTime").textContent,
  }));
  assert(paused.audit.active && !paused.audit.playing, "Replay did not pause");
  assert(paused.audit.index === pausedLater.audit.index, "Paused replay advanced");
  assert(paused.time === pausedLater.time, "Paused replay clock advanced");

  await page.click("#replayStep");
  const stepped = await page.evaluate(() => ({
    audit: window.__WINCH_GAME__.getReplayAudit(),
    time: document.querySelector("#replayTime").textContent,
  }));
  assert(stepped.audit.index === paused.audit.index + 1, "Single step did not advance one frame");
  assert(!stepped.audit.playing, "Single step resumed playback");
  await page.screenshot({ path: path.join(SHOTS, "replay-paused.png"), fullPage: true });

  await page.selectOption("#replaySpeed", "2");
  await page.click("#replayToggle");
  const startedAt = Date.now();
  let end = null;
  while (Date.now() - startedAt < 24000) {
    end = await page.evaluate(() => ({
      audit: window.__WINCH_GAME__.getReplayAudit(),
      proof: document.querySelector("#replayProof").textContent,
      proofClass: document.querySelector("#replayProof").className,
      time: document.querySelector("#replayTime").textContent,
      hash: document.querySelector("#finalHashValue").textContent,
    }));
    if (!end.audit.playing && end.audit.index === end.audit.frameCount - 1) break;
    await page.waitForTimeout(100);
  }
  const liveHash = await page.evaluate(() => window.__WINCH_GAME__.getLiveFinalHash());
  assert(end, "Replay did not produce a final state");
  assert(end.audit.index === end.audit.frameCount - 1, "Replay did not reach the final frame");
  assert(end.audit.expectedHash === end.audit.viewedHash,
    "Replay final hash does not match recorded hash");
  assert(end.hash === end.audit.expectedHash, "Replay final hash display is inconsistent");
  assert(end.proof.includes("终态一致"), "Replay did not report a matching final state");
  assert(liveHash === paused.liveHash, "Replay mutated the live shared state");
  assert(errors.length === 0, `Replay page errors: ${errors.join(" | ")}`);
  await page.screenshot({ path: path.join(SHOTS, "replay-complete.png"), fullPage: true });

  const result = {
    paused: {
      frame: paused.audit.index,
      time: paused.time,
      stableAfter600ms: paused.audit.index === pausedLater.audit.index,
    },
    singleStep: {
      from: paused.audit.index,
      to: stepped.audit.index,
      time: stepped.time,
    },
    final: {
      frame: end.audit.index,
      frames: end.audit.frameCount,
      time: end.time,
      expectedHash: end.audit.expectedHash,
      viewedHash: end.audit.viewedHash,
      proof: end.proof,
      liveStateUntouched: liveHash === paused.liveHash,
    },
  };
  await context.close();
  return result;
}

const server = await startServer(0);
const browser = await chromium.launch({ headless: true });
const summary = {
  startedAt: new Date().toISOString(),
  success: null,
  failure: null,
  protection: null,
  replay: null,
};

try {
  summary.success = await testSuccessfulMission(browser, server.url);
  console.log("✓ 完整成功流程与存档恢复");
  summary.failure = await testFailureAndConflict(browser, server.url);
  console.log("✓ 失败流程与动作顺序冲突");
  summary.protection = await testProtectionAndRecovery(browser, server.url);
  console.log("✓ 断索保护、输入冻结与刷新恢复");
  summary.replay = await testCompleteReplay(browser, server.url);
  console.log("✓ 完整回放暂停/单步/倍速终态一致");
  summary.finishedAt = new Date().toISOString();
  summary.ok = true;
} catch (error) {
  summary.ok = false;
  summary.error = error.stack || String(error);
  console.error(summary.error);
  process.exitCode = 1;
} finally {
  fs.writeFileSync(
    path.join(ARTIFACTS, "verification-result.json"),
    JSON.stringify(summary, null, 2),
  );
  await browser.close();
  await server.close();
}
