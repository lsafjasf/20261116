import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderScene } from '../render/renderer.js';
import { createVirtualCanvas } from '../render/virtual-canvas.js';
import { encodePng } from '../render/png.js';
import {
  serializeScene,
  deserializeScene,
  canonicalScene,
  SCHEMA_VERSION,
} from './serialize.js';
import { flattenDrawOrder } from './scene.js';
import { keyframeCount } from './keyframes.js';

function sha256Short(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// 导出前工程快照：完整深拷贝 + 序列化文本，保证可回溯
export function takeProjectSnapshot(root) {
  return {
    takenAt: null,
    schemaVersion: SCHEMA_VERSION,
    root: structuredClone(root),
    serialized: serializeScene(root),
    drawOrder: flattenDrawOrder(root).map((n) => n.id),
    keyframeCount: keyframeCount(root),
  };
}

// 渲染 -> PNG，并同步返回画布像素供调用方与屏幕预览比对
export function renderToPng(root, options = {}) {
  const width = options.width ?? 480;
  const height = options.height ?? 360;
  const canvas = createVirtualCanvas(width, height, options.background ?? '#f4f6fa');
  const result = renderScene(canvas, root, {
    width,
    height,
    background: options.background ?? '#f4f6fa',
    highlightIds: options.highlightIds,
  });
  const png = encodePng(width, height, result.ctx.pixels);
  return {
    png,
    pixels: result.ctx.pixels,
    drawOrder: result.drawOrder,
    visibleIds: result.visibleIds,
    width,
    height,
  };
}

// 重载一致性校验：顺序/关键帧/坐标/颜色逐项对比
export function verifyReloadIntegrity(originalRoot) {
  const text = serializeScene(originalRoot);
  const reloaded = deserializeScene(text);
  const checks = {
    canonicalEqual: canonicalScene(originalRoot) === canonicalScene(reloaded),
    drawOrderEqual:
      JSON.stringify(flattenDrawOrder(originalRoot).map((n) => n.id)) ===
      JSON.stringify(flattenDrawOrder(reloaded).map((n) => n.id)),
    keyframeCountEqual:
      keyframeCount(originalRoot) === keyframeCount(reloaded),
    transformsEqual: collectTransforms(originalRoot) === collectTransforms(reloaded),
    colorsEqual: collectColors(originalRoot) === collectColors(reloaded),
  };
  checks.passed = Object.entries(checks)
    .filter(([k]) => k !== 'passed')
    .every(([, v]) => v === true);
  return { checks, reloaded };
}

function collectTransforms(root) {
  return flattenDrawOrder(root)
    .map((n) => `${n.id}:${JSON.stringify(n.transform)}`)
    .join('|');
}

function collectColors(root) {
  return flattenDrawOrder(root)
    .map((n) => `${n.id}:${n.style.fill}:${n.style.opacity}`)
    .join('|');
}

// 完整导出：先留快照，再渲染，再做重载校验，最后落盘并生成清单
export function exportProject(root, outDir, options = {}) {
  mkdirSync(outDir, { recursive: true });
  const stamp = options.stamp ?? 'snapshot';
  const snapshot = takeProjectSnapshot(root);
  snapshot.takenAt = options.clock ?? null;
  const rendered = renderToPng(root, options);
  const { checks, reloaded } = verifyReloadInsights(root);
  const pngPath = join(outDir, `export-${stamp}.png`);
  const jsonPath = join(outDir, `export-${stamp}.json`);
  const snapshotPath = join(outDir, `snapshot-${stamp}.json`);
  writeFileSync(pngPath, rendered.png);
  writeFileSync(jsonPath, snapshot.serialized);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  const manifest = {
    stamp,
    files: { png: pngPath, project: jsonPath, snapshot: snapshotPath },
    checksums: {
      png: sha256Short(rendered.png),
      project: sha256Short(Buffer.from(snapshot.serialized)),
    },
    reloadChecks: checks,
    drawOrder: rendered.drawOrder,
    visibleIds: rendered.visibleIds,
    width: rendered.width,
    height: rendered.height,
  };
  writeFileSync(join(outDir, `manifest-${stamp}.json`), JSON.stringify(manifest, null, 2));
  return { manifest, rendered, snapshot, reloaded };
}

function verifyReloadInsights(root) {
  return verifyReloadIntegrity(root);
}
