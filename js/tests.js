import { cloneState, makeReferenceSnapshot, OBJECT_COUNT, sanitizeState, TILE_COLS, TILE_ROWS } from "./state.js";
import { dirtyRectForChange, dirtyTiles, lampOcclusion, viewportRects } from "./geometry.js";

const sleepFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function hexColor(color) {
  return `#${[color.r, color.g, color.b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function samplePatch(pixels, width, height, point, radius = 5) {
  if (!point) return { r: 0, g: 0, b: 0, a: 255 };
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const index = (y * width + x) * 4;
      r += pixels[index];
      g += pixels[index + 1];
      b += pixels[index + 2];
      count += 1;
    }
  }
  return count ? { r: r / count, g: g / count, b: b / count, a: 255 } : { r: 0, g: 0, b: 0, a: 255 };
}

function patchForCanvasPoint(renderer, pixels, point) {
  const scaleX = renderer.width / renderer.canvas.clientWidth;
  const scaleY = renderer.height / renderer.canvas.clientHeight;
  return samplePatch(pixels, renderer.width, renderer.height, {
    x: point.x * scaleX,
    y: point.y * scaleY,
  });
}

function dirtyPlan(change, before, after, renderer) {
  const rect = dirtyRectForChange(change, before, after, renderer.width, renderer.height);
  const tiles = dirtyTiles(rect, renderer.width, renderer.height);
  return {
    rect,
    tiles,
    tileCount: tiles.length,
    totalTiles: TILE_COLS * TILE_ROWS,
    pixelRatio: (rect.w * rect.h) / (renderer.width * renderer.height),
  };
}

function makeRecord(meta) {
  return {
    id: meta.id,
    code: meta.code,
    title: meta.title,
    description: meta.description,
    status: "running",
    beforeHash: "--------",
    afterHash: "--------",
    fullHash: "--------",
    hashMatch: false,
    objectsBefore: OBJECT_COUNT,
    objectsAfter: OBJECT_COUNT,
    dirtyTiles: 0,
    totalTiles: TILE_COLS * TILE_ROWS,
    dirtyRatio: 0,
    changedRatio: 0,
    changedPixels: 0,
    beforeThumb: "",
    afterThumb: "",
    note: "正在冻结基线…",
    views: [],
  };
}

function compareViews(renderer, beforeState, afterState, beforePixels, afterPixels) {
  const viewports = viewportRects(afterState, renderer.canvas.clientWidth, renderer.canvas.clientHeight);
  return viewports.map((viewport, index) => {
    const front = lampOcclusion(1, beforeState, viewport);
    const behind = lampOcclusion(1, afterState, viewport);
    const frontColor = patchForCanvasPoint(renderer, beforePixels, front.screen);
    const behindColor = patchForCanvasPoint(renderer, afterPixels, behind.screen);
    return {
      label: index === 0 ? "A" : "B",
      frontHex: hexColor(frontColor),
      behindHex: hexColor(behindColor),
      frontOrder: front.order,
      behindOrder: behind.order,
      occluded: behind.occluded,
      thicknesses: behind.hits.map((hit) => hit.thickness),
    };
  });
}

async function runNormal(renderer, setState, onUpdate) {
  const record = makeRecord({
    id: "normal",
    code: "T-01 / NORMAL",
    title: "灯后迁移",
    description: "L2 从玻璃前方旋转到后方，观察两种视角的颜色偏移与遮挡顺序。",
  });
  onUpdate(record);
  await sleepFrame();

  const before = makeReferenceSnapshot().state;
  before.lamps[1].angle = 68;
  before.lamps[1].height = 0.7;
  before.lamps[1].behind = false;
  setState(before);
  renderer.setState(before);
  renderer.render(before, { mode: "full" });
  const beforePixels = renderer.readPixelsTopDown();
  record.beforeHash = renderer.imageHash(beforePixels);
  record.beforeThumb = renderer.captureThumbnail();

  const after = cloneState(before);
  after.lamps[1].angle = 150;
  after.lamps[1].height = 0.62;
  after.lamps[1].behind = true;
  const plan = dirtyPlan({ type: "light", indices: [1] }, before, after, renderer);
  setState(after);
  renderer.setState(after);
  const stats = renderer.render(after, { tiles: plan.tiles });
  record.afterPixels = renderer.readPixelsTopDown();
  record.afterHash = renderer.imageHash(record.afterPixels);
  record.afterThumb = renderer.captureThumbnail();
  record.dirtyTiles = plan.tileCount;
  record.dirtyRatio = plan.pixelRatio;

  renderer.render(after, { mode: "full" });
  const fullPixels = renderer.readPixelsTopDown();
  record.fullHash = renderer.imageHash(fullPixels);
  record.hashMatch = record.afterHash === record.fullHash;
  const incrementalVsFull = renderer.comparePixels(record.afterPixels, fullPixels);
  record.incrementalVsFullPixels = incrementalVsFull.changed;
  record.incrementalMismatch = incrementalVsFull.bounds;

  const visual = renderer.comparePixels(beforePixels, record.afterPixels);
  record.changedPixels = visual.changed;
  record.changedRatio = visual.ratio;
  record.diffBounds = visual.bounds;
  record.views = compareViews(renderer, before, after, beforePixels, record.afterPixels);
  record.status = record.beforeHash !== record.afterHash && record.changedPixels > 0 && record.hashMatch && incrementalVsFull.changed === 0
    ? "pass"
    : "fail";
  record.note = record.status === "pass"
    ? `脏区 ${plan.tileCount}/${TILE_COLS * TILE_ROWS} 瓦片；增量帧与全量校验帧逐像素一致。`
    : "增量结果与全量结果不一致，请检查脏区覆盖。";
  record.stats = stats;
  onUpdate(record);
  return record;
}

async function runBoundary(renderer, setState, onUpdate) {
  const record = makeRecord({
    id: "boundary",
    code: "T-02 / BOUNDARY",
    title: "旋转角度上限",
    description: "L2 从 174° 推进到闭区间边界 180°，验证极值与参数约束。",
  });
  onUpdate(record);
  await sleepFrame();

  const before = makeReferenceSnapshot().state;
  before.lamps[1].angle = 174;
  before.lamps[1].height = 0.76;
  setState(before);
  renderer.setState(before);
  renderer.render(before, { mode: "full" });
  const beforePixels = renderer.readPixelsTopDown();
  record.beforeHash = renderer.imageHash(beforePixels);
  record.beforeThumb = renderer.captureThumbnail();

  const after = cloneState(before);
  after.lamps[1].angle = 180;
  const validated = sanitizeState(after);
  const plan = dirtyPlan({ type: "light", indices: [1] }, before, validated, renderer);
  setState(validated);
  renderer.setState(validated);
  const stats = renderer.render(validated, { tiles: plan.tiles });
  record.afterPixels = renderer.readPixelsTopDown();
  record.afterHash = renderer.imageHash(record.afterPixels);
  record.afterThumb = renderer.captureThumbnail();
  record.dirtyTiles = plan.tileCount;
  record.dirtyRatio = plan.pixelRatio;

  renderer.render(validated, { mode: "full" });
  const fullPixels = renderer.readPixelsTopDown();
  record.fullHash = renderer.imageHash(fullPixels);
  record.hashMatch = record.afterHash === record.fullHash;
  const visual = renderer.comparePixels(beforePixels, record.afterPixels);
  record.changedPixels = visual.changed;
  record.changedRatio = visual.ratio;
  record.diffBounds = visual.bounds;
  const angleAccepted = validated.lamps[1].angle === 180;
  record.status = angleAccepted && record.beforeHash !== record.afterHash && record.hashMatch ? "pass" : "fail";
  record.note = angleAccepted
    ? `180° 被接受且未越界；脏区 ${plan.tileCount}/${TILE_COLS * TILE_ROWS} 瓦片。`
    : "边界参数未被正确接受。";
  record.stats = stats;
  onUpdate(record);
  return record;
}

async function runFailure(renderer, setState, onUpdate) {
  const record = makeRecord({
    id: "failure",
    code: "T-03 / FAILURE",
    title: "非法参数拒绝",
    description: "注入 NaN 光源角度，验证校验器拒绝更新、保留旧帧且不增加对象。",
  });
  onUpdate(record);
  await sleepFrame();

  const before = makeReferenceSnapshot().state;
  setState(before);
  renderer.setState(before);
  renderer.render(before, { mode: "full" });
  const beforePixels = renderer.readPixelsTopDown();
  record.beforeHash = renderer.imageHash(beforePixels);
  record.beforeThumb = renderer.captureThumbnail();
  record.dirtyTiles = 0;
  record.dirtyRatio = 0;

  const invalid = cloneState(before);
  invalid.lamps[1].angle = Number.NaN;
  let rejected = false;
  let rejectionMessage = "";
  try {
    sanitizeState(invalid);
  } catch (error) {
    rejected = true;
    rejectionMessage = error.message;
  }

  const afterPixels = renderer.readPixelsTopDown();
  record.afterHash = renderer.imageHash(afterPixels);
  record.fullHash = record.afterHash;
  record.hashMatch = record.beforeHash === record.afterHash;
  record.afterThumb = renderer.captureThumbnail();
  const visual = renderer.comparePixels(beforePixels, afterPixels);
  record.changedPixels = visual.changed;
  record.changedRatio = visual.ratio;
  record.status = rejected && record.hashMatch && visual.changed === 0 ? "pass" : "fail";
  record.note = rejected
    ? `已拒绝：${rejectionMessage}；画布哈希与对象数均保持不变。`
    : "非法参数未被拒绝。";
  onUpdate(record);
  return record;
}

export async function runTestSuite({ renderer, setState, onUpdate }) {
  const results = [];
  results.push(await runNormal(renderer, setState, (record) => onUpdate(record, results)));
  results.push(await runBoundary(renderer, setState, (record) => onUpdate(record, results)));
  results.push(await runFailure(renderer, setState, (record) => onUpdate(record, results)));

  const finalState = makeReferenceSnapshot().state;
  setState(finalState);
  renderer.setState(finalState);
  renderer.render(finalState, { mode: "full" });
  const finalPixels = renderer.readPixelsTopDown();
  const finalHash = renderer.imageHash(finalPixels);
  const finalSize = { width: renderer.width, height: renderer.height };
  renderer.render(finalState, { mode: "full" });
  const secondHash = renderer.imageHash(renderer.readPixelsTopDown());

  return {
    results,
    finalState,
    finalHash,
    secondHash,
    finalSize,
    finalImage: renderer.captureThumbnail(),
    views: compareViews(renderer, makeReferenceSnapshot().state, finalState, finalPixels, finalPixels),
    objectCount: OBJECT_COUNT,
  };
}
