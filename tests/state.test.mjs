import assert from "node:assert/strict";
import test from "node:test";

class MemoryStorage {
  #data = new Map();
  getItem(key) {
    return this.#data.has(key) ? this.#data.get(key) : null;
  }
  setItem(key, value) {
    this.#data.set(key, String(value));
  }
  removeItem(key) {
    this.#data.delete(key);
  }
  clear() {
    this.#data.clear();
  }
}

globalThis.localStorage = new MemoryStorage();

const core = await import("../js/core.js");
const operations = await import("../js/operations.js");

test("草稿、选中对象与滚动位置可跨刷新恢复", () => {
  localStorage.clear();
  const { state } = core.loadState();
  state.drafts.image.note = "刷新后仍应存在";
  state.selectedId = "clip-audio";
  state.view.timelineScroll = 187;
  state.view.inspectorScroll = 96;
  core.persist(state, "测试保存");

  const loaded = core.loadState().state;
  assert.equal(loaded.drafts.image.note, "刷新后仍应存在");
  assert.equal(loaded.selectedId, "clip-audio");
  assert.equal(loaded.view.timelineScroll, 187);
  assert.equal(loaded.view.inspectorScroll, 96);
});

test("刷新时遗留的运行态会转换为可重试安全快照", () => {
  localStorage.clear();
  const state = core.createInitialState();
  state.modules.image.status = "running";
  state.modules.image.stage = "解码图像";
  state.modules.image.attempt = 3;
  state.modules.image.operationKey = "image:clip-image:interrupted";
  localStorage.setItem(core.STORAGE_KEY, JSON.stringify(state));

  const loaded = core.loadState().state;
  assert.equal(loaded.modules.image.status, "error");
  assert.equal(loaded.modules.image.stage, "解码图像");
  assert.equal(loaded.modules.image.error.code, "INTERRUPTED_BY_REFRESH");
  assert.match(loaded.modules.image.error.advice, /重试|复用/);
  assert.ok(loaded.modules.image.snapshot);
  assert.equal(loaded.modules.image.operationKey, "image:clip-image:interrupted");
  assert.ok(loaded.logs.some((entry) => entry.stage === "刷新恢复"));
});

test("撤销只回滚工程内容，不丢未提交草稿与视图位置", () => {
  localStorage.clear();
  const { state } = core.loadState();
  const image = state.clips.find((clip) => clip.id === "clip-image");
  core.recordProjectChange(state, "测试提交", () => {
    image.style.brightness = 130;
  });
  state.drafts.image.note = "未提交备注";
  state.view.timelineScroll = 240;
  state.selectedId = "clip-audio";

  assert.equal(core.undo(state), true);
  assert.equal(state.clips.find((clip) => clip.id === "clip-image").style.brightness, 112);
  assert.equal(state.drafts.image.note, "未提交备注");
  assert.equal(state.selectedId, "clip-audio");
  assert.equal(state.view.timelineScroll, 240);
  assert.equal(core.redo(state), true);
  assert.equal(state.clips.find((clip) => clip.id === "clip-image").style.brightness, 130);
});

test("确定性资源键重复登记只保留一份资源", () => {
  localStorage.clear();
  const { state } = core.loadState();
  const key = "image:clip-image:abc123";
  const first = core.ensureResource(state, "image", key, { label: "图像" });
  const second = core.ensureResource(state, "image", key, { label: "图像" });
  const third = core.ensureResource(state, "image", "image:clip-image:def456", { label: "图像新版本" });

  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(Object.keys(state.resources).length, 2);
  assert.equal(first.resource.count, 1);
  assert.equal(first.resource.reuses, 1);
  assert.notEqual(first.resource.id, third.resource.id);
});

test("图像故障失败后重试复用同一资源并完成", async () => {
  localStorage.clear();
  const { state } = core.loadState();
  state.faults.image = true;
  const failed = await operations.runModule(state, "image", { stepDelay: 1 });
  assert.equal(failed.ok, false);
  assert.equal(state.modules.image.status, "error");
  assert.equal(state.modules.image.error.stage, "解码图像");
  assert.match(state.modules.image.error.advice, /重试|草稿|保留/);
  assert.equal(Object.keys(state.resources).length, 1);
  const resourceId = state.modules.image.resourceId;
  const operationKey = state.modules.image.operationKey;

  const recovered = await operations.runModule(state, "image", { isRetry: true, stepDelay: 1 });
  assert.equal(recovered.ok, true);
  assert.equal(state.modules.image.status, "ready");
  assert.equal(Object.keys(state.resources).length, 1);
  assert.equal(state.modules.image.resourceId, resourceId);
  assert.equal(state.modules.image.operationKey, operationKey);
  assert.equal(state.resources[resourceId].reuses, 1);
});

test("三个模块故障都只影响各自边界并保留可读快照", async () => {
  for (const moduleId of ["image", "audio", "export"]) {
    localStorage.clear();
    const { state } = core.loadState();
    state.faults[moduleId] = true;
    state.faults.persistent = true;
    const first = await operations.runModule(state, moduleId, { stepDelay: 1, download: false });
    const firstResource = state.modules[moduleId].resourceId;
    const firstSnapshot = state.modules[moduleId].error.snapshot;
    assert.equal(first.ok, false);
    assert.ok(firstSnapshot);
    assert.equal(Object.keys(state.resources).length, 1);

    const retry = await operations.runModule(state, moduleId, { isRetry: true, stepDelay: 1, download: false });
    assert.equal(retry.ok, false);
    assert.equal(state.modules[moduleId].status, "error");
    assert.equal(state.modules[moduleId].resourceId, firstResource);
    assert.ok(state.modules[moduleId].error.snapshot);
    assert.ok(operations.snapshotText(state.modules[moduleId].error.snapshot).length > 10);
    assert.equal(Object.keys(state.resources).length, 1);
    assert.equal(state.resources[firstResource].reuses, 1);
    assert.equal(state.clips.length, 2);
  }
});
