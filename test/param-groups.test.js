import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoScene, testParams } from '../src/core/demo.js';
import { EditorController } from '../src/core/commands.js';
import {
  findNode,
  computeWorldMatrices,
  effectiveVisibility,
} from '../src/core/scene.js';
import { applyPoint, invert } from '../src/core/math.js';
import { renderToPng, verifyReloadIntegrity } from '../src/core/exporter.js';
import { createVirtualCanvas } from '../src/render/virtual-canvas.js';
import { renderScene } from '../src/render/renderer.js';
import { sampleAt } from '../src/core/keyframes.js';
import { serializeScene } from '../src/core/serialize.js';
import { validateNode } from '../src/core/scene.js';

// 默认参数：完整正向流程，可重复执行结果一致
test('默认参数组：选择->父链高亮->移动同步->隐藏->删除->撤销->导出一致', () => {
  const p = testParams().default;
  const ctrl = new EditorController(buildDemoScene());

  const selection = ctrl.select(p.selectId);
  assert.deepEqual([...selection.highlightIds], ['stage', 'cardGroup', 'grid', 'marker']);

  const matrices0 = computeWorldMatrices(ctrl.root);
  const childBefore = applyPoint(matrices0.get(p.selectId), 0, 0);
  ctrl.moveBy(p.parentMove.id, p.parentMove.dx, p.parentMove.dy);
  const matrices1 = computeWorldMatrices(ctrl.root);
  const childAfter = applyPoint(matrices1.get(p.selectId), 0, 0);
  assert.equal(childAfter.x - childBefore.x, 50);
  assert.equal(childAfter.y - childBefore.y, 25);

  ctrl.hide(p.hideId);
  assert.equal(effectiveVisibility(ctrl.root, 'marker'), false);
  ctrl.undo();
  assert.equal(effectiveVisibility(ctrl.root, 'marker'), true);

  ctrl.deleteNode(p.deleteId);
  assert.equal(findNode(ctrl.root, p.deleteId), null);
  ctrl.undo();
  assert.equal(findNode(ctrl.root, p.deleteId).id, 'badge');

  const sampled = sampleAt(ctrl.root, p.sampleTime);
  assert.equal(findNode(sampled, 'badge').transform.x, 5);

  const png1 = renderToPng(ctrl.root, p.canvas).png;
  const png2 = renderToPng(ctrl.root, p.canvas).png;
  assert.deepEqual(Buffer.from(png1), Buffer.from(png2), '重复渲染结果必须一致');

  const { checks } = verifyReloadIntegrity(ctrl.root);
  assert.equal(checks.passed, true);
  assert.equal(checks.drawOrderEqual, true);
  assert.equal(checks.keyframeCountEqual, true);
});

// 边界参数：1x1 画布、零位移、零透明度、重排到边界下标
test('边界参数组：1x1 画布与极端但合法的值', () => {
  const p = testParams().boundary;
  const ctrl = new EditorController(buildDemoScene());
  ctrl.select(p.selectId);
  ctrl.moveBy(p.parentMove.id, p.parentMove.dx, p.parentMove.dy);
  assert.equal(findNode(ctrl.root, 'cardGroup').transform.x, 240);

  const backdrop = findNode(ctrl.root, 'backdrop');
  backdrop.style.opacity = p.extreme.opacity;
  const canvas = createVirtualCanvas(p.canvas.width, p.canvas.height, p.canvas.background);
  const result = renderScene(canvas, ctrl.root, p.canvas);
  assert.equal(result.width * result.height, 1);

  const target = ctrl.moveInOrder('backdrop', p.reorderTarget);
  assert.equal(target, 0);
  assert.equal(findNode(ctrl.root, 'cardGroup').children[0].id, 'backdrop');

  const sampled = sampleAt(ctrl.root, p.sampleTime);
  assert.equal(findNode(sampled, 'badge').transform.x, -40);

  // 奇异矩阵（缩放为 0）必须显式报错，而不是产出 NaN 画面
  findNode(ctrl.root, 'backdrop').transform.scaleX = 0;
  const singular = computeWorldMatrices(ctrl.root).get('backdrop');
  assert.throws(() => invert(singular), /不可逆/);
});

// 异常参数组：全部非法输入必须被拒绝或回退，工程不被破坏
test('异常参数组：非法 id/时间/颜色/删除根节点均安全失败', () => {
  const p = testParams().abnormal;
  const ctrl = new EditorController(buildDemoScene());
  const before = serializeScene(ctrl.root);

  assert.throws(() => ctrl.select(p.selectId), /节点不存在/);
  assert.throws(() => ctrl.moveBy(p.parentMove.id, 10, 10), /节点不存在/);
  assert.throws(() => ctrl.hide(p.hideId), /节点不存在/);
  assert.throws(() => ctrl.deleteNode(p.deleteId), /根节点/);
  assert.throws(() => sampleAt(ctrl.root, p.sampleTime), /采样时间/);

  const badColorNode = findNode(ctrl.root, 'badge');
  badColorNode.style.fill = p.badColor;
  assert.throws(() => validateNode(ctrl.root), /颜色/);
  badColorNode.style.fill = '#f59e0b';
  badColorNode.style.opacity = p.badOpacity;
  assert.throws(() => validateNode(ctrl.root), /opacity/);
  badColorNode.style.opacity = 1;

  // 失败后工程快照未被污染，仍可正常导出
  assert.equal(serializeScene(ctrl.root), before);
  const png = renderToPng(ctrl.root, p.canvas);
  assert.ok(png.png.length > 0);
  assert.equal(ctrl.history.size, 0, '失败操作不得写入撤销历史');
});
