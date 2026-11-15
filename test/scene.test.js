import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoScene } from '../src/core/demo.js';
import {
  findNode,
  parentChain,
  computeWorldMatrices,
  effectiveVisibility,
  flattenDrawOrder,
  reorder,
  createNode,
} from '../src/core/scene.js';
import { applyPoint } from '../src/core/math.js';

test('三层对象树结构与父子层级', () => {
  const root = buildDemoScene();
  assert.equal(root.id, 'stage');
  const cardGroup = findNode(root, 'cardGroup');
  assert.deepEqual(
    cardGroup.children.map((n) => n.id),
    ['backdrop', 'badge', 'grid'],
  );
  assert.equal(findNode(root, 'grid').children[0].id, 'marker');
  assert.equal(flattenDrawOrder(root).map((n) => n.id).length, 6);
});

test('选择子对象时返回完整父链用于高亮', () => {
  const root = buildDemoScene();
  const chain = parentChain(root, 'marker').map((n) => n.id);
  assert.deepEqual(chain, ['stage', 'cardGroup', 'grid', 'marker']);
  const badgeChain = parentChain(root, 'badge').map((n) => n.id);
  assert.deepEqual(badgeChain, ['stage', 'cardGroup', 'badge']);
});

test('移动父对象后子对象世界坐标同步变化', () => {
  const root = buildDemoScene();
  const before = computeWorldMatrices(root);
  const markerBefore = applyPoint(before.get('marker'), 0, 0);
  findNode(root, 'cardGroup').transform.x += 50;
  findNode(root, 'cardGroup').transform.y += 25;
  const after = computeWorldMatrices(root);
  const markerAfter = applyPoint(after.get('marker'), 0, 0);
  assert.equal(markerAfter.x - markerBefore.x, 50);
  assert.equal(markerAfter.y - markerBefore.y, 25);
  // 本地坐标保持不变
  assert.equal(findNode(root, 'marker').transform.x, 30);
});

test('隐藏父层后所有后代实际不可见，不留下可见子层', () => {
  const root = buildDemoScene();
  assert.equal(effectiveVisibility(root, 'marker'), true);
  findNode(root, 'cardGroup').visible = false;
  for (const id of ['backdrop', 'badge', 'grid', 'marker']) {
    assert.equal(effectiveVisibility(root, id), false, `${id} 应随父层隐藏`);
  }
  findNode(root, 'grid').visible = false;
  assert.equal(effectiveVisibility(root, 'grid'), false);
  assert.equal(effectiveVisibility(root, 'marker'), false);
});

test('children 数组顺序即绘制顺序，重排后覆盖关系改变', () => {
  const root = buildDemoScene();
  const order = () => flattenDrawOrder(root).map((n) => n.id);
  assert.deepEqual(order(), ['stage', 'cardGroup', 'backdrop', 'badge', 'grid', 'marker']);
  reorder(root, 'backdrop', 2);
  assert.deepEqual(
    findNode(root, 'cardGroup').children.map((n) => n.id),
    ['badge', 'grid', 'backdrop'],
  );
});

test('非法节点参数被拒绝', () => {
  assert.throws(() => createNode({ style: { fill: '#123', opacity: 1 } }), /颜色/);
  assert.throws(
    () => createNode({ style: { fill: '#123456', opacity: 2 } }),
    /opacity/,
  );
  assert.throws(
    () => createNode({ geometry: { w: -1, h: 10 } }),
    /不能为负/,
  );
  assert.throws(
    () => createNode({ transform: { x: NaN, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } }),
    /有限数值/,
  );
});
