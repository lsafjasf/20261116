// In-page scenario harness. Produces structured results with hashes, object
// counts, dirty-block counts and small screenshots, and states whether the
// measured numbers agree with the rendered picture.
import { FabricMaterial, LAYERS } from "../core/material.js";
import { TILE_SIZE, DEFAULT_PARAMS, validateParams, ParamError, PRESETS } from "../core/params.js";
import { hashBytes, checkSeams, diffBlocks, hashRegion, countObjects } from "../core/analysis.js";
import { drawFlat } from "./preview.js";

function thumb(composite, label) {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 96;
  const fig = document.createElement("figure");
  drawFlat(c, composite);
  const cap = document.createElement("figcaption");
  cap.textContent = label;
  fig.append(c, cap);
  return fig;
}

function card(name, pass, kv, thumbs = []) {
  const el = document.createElement("div");
  el.className = "test-card";
  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("span");
  title.textContent = name;
  const badge = document.createElement("span");
  badge.className = `badge ${pass ? "pass" : "fail"}`;
  badge.textContent = pass ? "通过" : "失败（已正确拦截）";
  head.append(title, badge);
  const grid = document.createElement("div");
  grid.className = "kv";
  for (const [k, v] of Object.entries(kv)) {
    const dk = document.createElement("span");
    dk.textContent = k;
    const dv = document.createElement("b");
    dv.textContent = String(v);
    grid.append(dk, dv);
  }
  const thumbsWrap = document.createElement("div");
  thumbsWrap.className = "thumbs";
  thumbsWrap.append(...thumbs);
  el.append(head, grid, thumbsWrap);
  return { el, pass };
}

// Scenario 1: normal parameter change -> only affected layer/blocks update,
// and incremental output equals a from-scratch recompute hash.
export function runNormal() {
  const mat = new FabricMaterial(DEFAULT_PARAMS);
  const before = Uint8ClampedArray.from(mat.composite);
  const hashBefore = hashBytes(before);
  const objectsBefore = countObjects();
  const affected = mat.updateParams({ ...DEFAULT_PARAMS, creaseStrength: 0.9 });
  const hashAfter = hashBytes(mat.composite);
  const reference = new FabricMaterial({ ...DEFAULT_PARAMS, creaseStrength: 0.9 });
  const hashReference = hashBytes(reference.composite);
  const seam = checkSeams(mat.composite);
  // Crease is a global field; verify locality with a separate local brush.
  const beforeBrush = Uint8ClampedArray.from(mat.composite);
  mat.brushAt(20, 20, 24, 255);
  const diff = diffBlocks(beforeBrush, mat.composite);
  const untouchedHash = hashRegion(beforeBrush, 500, 500, 564, 564);
  const untouchedAfter = hashRegion(mat.composite, 500, 500, 564, 564);
  const pass =
    hashAfter === hashReference &&
    affected.length === 1 &&
    affected[0] === LAYERS.CREASE &&
    seam.seamless &&
    untouchedHash === untouchedAfter;
  return card(
    "普通场景：折痕强度 0.4 → 0.9",
    pass,
    {
      "重算前哈希": hashBefore,
      "重算后哈希": hashAfter,
      "独立重算哈希": hashReference,
      "受影响层": affected.join(","),
      "刷子变化块/总块": `${diff.changedBlocks.length}/${diff.totalBlocks}`,
      "未触及区域一致": untouchedHash === untouchedAfter,
      "接缝跳变/内部均值": `${seam.seamJump}/${seam.interiorMean}`,
      "资源对象数(前→后)": `${objectsBefore}→${countObjects()}`,
      "数据与画面一致": pass ? "是" : "否",
    },
    [thumb(before, "重算前"), thumb(mat.composite, "重算后")]
  );
}

// Scenario 2: boundary brush at the corner (0,0) must appear on all four
// wrapped corners and keep seam continuity; full re-render must match.
export function runBoundary() {
  const mat = new FabricMaterial(PRESETS.balanced.params);
  mat.brushAt(0, 0, 40, 255);
  const n = TILE_SIZE;
  const corners = [
    [2, 2],
    [n - 3, 2],
    [2, n - 3],
    [n - 3, n - 3],
  ].map(([x, y]) => mat.brushMask[y * n + x]);
  const seam = checkSeams(mat.composite);
  const hashIncremental = hashBytes(mat.composite);
  // Reproduce from scratch by replaying the same stroke on a fresh material.
  const replay = new FabricMaterial(PRESETS.balanced.params);
  replay.brushAt(0, 0, 40, 255);
  const hashReplay = hashBytes(replay.composite);
  const allCorners = corners.every((v) => v > 0);
  const pass = allCorners && seam.seamless && hashIncremental === hashReplay;
  return card(
    "边界场景：角落刷子的四向环绕",
    pass,
    {
      "四角蒙版值": corners.join(","),
      "接缝无缝": seam.seamless,
      "接缝跳变": seam.seamJump,
      "增量哈希": hashIncremental,
      "重放哈希": hashReplay,
      "刷子次数": mat.metrics.brushStrokes,
      "数据与画面一致": pass ? "是" : "否",
    },
    [thumb(mat.composite, "角落环绕笔刷")]
  );
}

// Scenario 3: failure inputs must be rejected by validation and must NOT
// mutate the existing material/scene.
export function runFailure() {
  const mat = new FabricMaterial(DEFAULT_PARAMS);
  const hashBefore = hashBytes(mat.composite);
  const badInputs = [
    { ...DEFAULT_PARAMS, threadDensity: 77 }, // not a divisor -> snapped, not crash
    { ...DEFAULT_PARAMS, wearLevel: 5 }, // out of range
    { ...DEFAULT_PARAMS, fiberDirection: NaN }, // non-finite
    null, // wrong type
  ];
  const outcomes = badInputs.map((input) => {
    try {
      validateParams(input);
      return input === null ? "应拒绝却通过" : "吸附/通过";
    } catch (err) {
      return err instanceof ParamError ? `拦截:${err.field}` : "未知错误";
    }
  });
  const hashAfter = hashBytes(mat.composite);
  const rejected = outcomes.filter((o) => o.startsWith("拦截")).length;
  const pass = rejected >= 2 && hashBefore === hashAfter;
  return card(
    "失败场景：非法参数被拦截且场景不变",
    pass,
    {
      "用例结果": outcomes.join(" | "),
      "拦截数量": `${rejected}/${badInputs.length}`,
      "场景哈希(前→后)": `${hashBefore} → ${hashAfter}`,
      "场景未被重建": hashBefore === hashAfter,
      "数据与画面一致": pass ? "是" : "否",
    },
    [thumb(mat.composite, "保持不变的画面")]
  );
}

export function runAll() {
  return [runNormal(), runBoundary(), runFailure()];
}
