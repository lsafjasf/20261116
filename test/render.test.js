import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoScene } from '../src/core/demo.js';
import { createVirtualCanvas } from '../src/render/virtual-canvas.js';
import { renderScene } from '../src/render/renderer.js';
import { renderToPng } from '../src/core/exporter.js';
import { findNode } from '../src/core/scene.js';

function render(root, opts = {}) {
  const canvas = createVirtualCanvas(480, 360, '#f4f6fa');
  return renderScene(canvas, root, { width: 480, height: 360, ...opts });
}

test('同层后绘制的节点覆盖先绘制的节点（绘制顺序）', () => {
  const root = buildDemoScene();
  const { ctx } = render(root);
  // grid 中心位于 cardGroup(240,180)+本地(30,20)=(270,200)，绿色网格覆盖蓝色背景
  const [r, g, b] = ctx.getPixel(270, 200);
  assert.ok(g > r && g > b, `该像素应偏绿，实际 rgb(${r},${g},${b})`);
  // 背景区域仍是蓝色
  const [br, bg, bb] = ctx.getPixel(180, 180);
  assert.ok(bb > br && bb > bg, '背景区域应为蓝色');
});

test('裁剪：超出 clipRect 的子内容不产生像素', () => {
  const root = buildDemoScene();
  // marker 世界位置 (240+30+30, 180+20+20)=(300,220)，在裁剪区内
  const inside = render(root).ctx.getPixel(300, 220);
  assert.ok(inside[0] > 200 && inside[1] < 120, '裁剪区内应看到红色 marker');
  // 把 marker 平移到父级裁剪区 clipRect(-90..90, -70..70) 之外
  findNode(root, 'marker').transform.x = 300;
  const { ctx } = render(root);
  const outside = ctx.getPixel(240 + 30 + 300, 220);
  assert.deepEqual(outside.slice(0, 3), [244, 246, 250], '裁剪区外只剩背景色');
});

test('隐藏父层后画面中没有任何后代颜色残留', () => {
  const root = buildDemoScene();
  findNode(root, 'cardGroup').visible = false;
  const { ctx, visibleIds } = render(root);
  assert.deepEqual(visibleIds, ['stage']);
  for (const color of ['#4f8cff', '#f59e0b', '#22c55e', '#ff4d4f']) {
    assert.equal(ctx.countColor(color), 0, `${color} 不应出现`);
  }
});

test('选择高亮在父链每个节点上产生高亮标记', () => {
  const root = buildDemoScene();
  const highlightIds = new Set(['stage', 'cardGroup', 'grid', 'marker']);
  const { ctx } = render(root, { highlightIds });
  const highlighted = ctx.drawLog.filter((d) => d.color === '#ffb020').length;
  assert.equal(highlighted, 4);
});

test('PNG 导出尺寸/签名正确且非空', () => {
  const root = buildDemoScene();
  const { png, width, height, drawOrder } = renderToPng(root);
  assert.equal(width, 480);
  assert.equal(height, 360);
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(png.length > 1000);
  assert.deepEqual(drawOrder, ['stage', 'cardGroup', 'backdrop', 'badge', 'grid', 'marker']);
});

test('预览与导出共用同一渲染结果（像素一致）', () => {
  const root = buildDemoScene();
  const preview = render(root).ctx.pixels;
  const exported = renderToPng(root).pixels;
  assert.equal(preview.length, exported.length);
  let diff = 0;
  for (let i = 0; i < preview.length; i += 1) {
    if (preview[i] !== exported[i]) diff += 1;
  }
  assert.equal(diff, 0);
});
