import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoScene } from '../src/core/demo.js';
import { EditorController } from '../src/core/commands.js';
import { findNode, computeWorldMatrices } from '../src/core/scene.js';
import { applyPoint } from '../src/core/math.js';

test('选择子对象高亮整条父链', () => {
  const ctrl = new EditorController(buildDemoScene());
  const { highlightIds } = ctrl.select('marker');
  assert.deepEqual([...highlightIds], ['stage', 'cardGroup', 'grid', 'marker']);
  assert.deepEqual([...ctrl.highlightSet()], [...highlightIds]);
});

test('移动父对象，子对象世界位置同步而本地坐标不变', () => {
  const ctrl = new EditorController(buildDemoScene());
  const before = computeWorldMatrices(ctrl.root);
  const p0 = applyPoint(before.get('badge'), 0, 0);
  ctrl.moveBy('cardGroup', 50, 25);
  const after = computeWorldMatrices(ctrl.root);
  const p1 = applyPoint(after.get('badge'), 0, 0);
  assert.equal(p1.x - p0.x, 50);
  assert.equal(p1.y - p0.y, 25);
  assert.equal(findNode(ctrl.root, 'badge').transform.x, -40);
});

test('隐藏父层后子层全部不可见，重新显示恢复', () => {
  const ctrl = new EditorController(buildDemoScene());
  ctrl.hide('cardGroup');
  assert.equal(findNode(ctrl.root, 'cardGroup').visible, false);
  assert.equal(findNode(ctrl.root, 'marker').visible, true);
  const undo = ctrl.undo();
  assert.equal(undo.restored, true);
  assert.equal(findNode(ctrl.root, 'cardGroup').visible, true);
});

test('从检查器删除节点并通过撤销完整恢复', () => {
  const ctrl = new EditorController(buildDemoScene());
  ctrl.select('badge');
  const removed = ctrl.deleteNode('badge');
  assert.equal(removed.node.id, 'badge');
  assert.equal(findNode(ctrl.root, 'badge'), null);
  assert.equal(ctrl.selectedId, null);
  assert.equal(ctrl.history.canUndo, true);
  const undo = ctrl.undo();
  assert.equal(undo.restored, true);
  assert.equal(findNode(ctrl.root, 'badge').id, 'badge');
  assert.equal(findNode(ctrl.root, 'badge').geometry.w, 44);
});

test('根节点禁止删除', () => {
  const ctrl = new EditorController(buildDemoScene());
  assert.throws(() => ctrl.deleteNode('stage'), /根节点/);
  assert.equal(ctrl.history.canUndo, false);
});

test('多次操作后可逐步撤销', () => {
  const ctrl = new EditorController(buildDemoScene());
  ctrl.moveBy('cardGroup', 10, 0);
  ctrl.moveBy('cardGroup', 0, 20);
  ctrl.hide('grid');
  assert.equal(ctrl.history.size, 3);
  ctrl.undo();
  assert.equal(findNode(ctrl.root, 'grid').visible, true);
  ctrl.undo();
  assert.equal(findNode(ctrl.root, 'cardGroup').transform.y, 180);
  ctrl.undo();
  assert.equal(findNode(ctrl.root, 'cardGroup').transform.x, 240);
  assert.equal(ctrl.history.canUndo, false);
});

test('异常选择/移动抛出明确错误', () => {
  const ctrl = new EditorController(buildDemoScene());
  assert.throws(() => ctrl.select('not-exist-id'), /节点不存在/);
  assert.throws(() => ctrl.moveBy('ghost', 1, 1), /节点不存在/);
  assert.throws(() => ctrl.moveBy('grid', NaN, 1), /有限数值/);
});
