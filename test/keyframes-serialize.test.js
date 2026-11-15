import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoScene } from '../src/core/demo.js';
import { sampleAt, keyframeCount, addKeyframe } from '../src/core/keyframes.js';
import { findNode } from '../src/core/scene.js';
import {
  serializeScene,
  deserializeScene,
  canonicalScene,
} from '../src/core/serialize.js';
import { flattenDrawOrder } from '../src/core/scene.js';

test('关键帧：数值通道线性插值，颜色通道阶跃，且不修改原树', () => {
  const root = buildDemoScene();
  const originalX = findNode(root, 'badge').transform.x;
  const mid = sampleAt(root, 30);
  assert.equal(findNode(mid, 'badge').transform.x, 5); // -40 -> 50 的中点
  assert.equal(findNode(mid, 'badge').style.fill, '#f59e0b');
  const end = sampleAt(root, 60);
  assert.equal(findNode(end, 'badge').transform.x, 50);
  assert.equal(findNode(end, 'badge').style.fill, '#10b981');
  assert.equal(findNode(root, 'badge').transform.x, originalX);
  assert.equal(keyframeCount(root), 4);
});

test('非法关键帧参数被拒绝', () => {
  const root = buildDemoScene();
  const badge = findNode(root, 'badge');
  assert.throws(() => addKeyframe(badge, 'x', -1, 0), /关键帧时间/);
  assert.throws(() => addKeyframe(badge, 'x', 10, 'nope'), /数值/);
  assert.throws(() => addKeyframe(badge, 'fill', 10, '#fff'), /#RRGGBB/);
  assert.throws(() => sampleAt(root, -5), /采样时间/);
});

test('序列化后重新载入：图层顺序/关键帧/坐标/颜色完全不变', () => {
  const root = buildDemoScene();
  const text = serializeScene(root);
  const reloaded = deserializeScene(text);
  assert.equal(canonicalScene(root), canonicalScene(reloaded));
  assert.deepEqual(
    flattenDrawOrder(reloaded).map((n) => n.id),
    flattenDrawOrder(root).map((n) => n.id),
  );
  assert.equal(keyframeCount(reloaded), keyframeCount(root));
  for (const id of flattenDrawOrder(root).map((n) => n.id)) {
    const a = findNode(root, id);
    const b = findNode(reloaded, id);
    assert.deepEqual(b.transform, a.transform, `${id} 坐标一致`);
    assert.equal(b.style.fill, a.style.fill, `${id} 颜色一致`);
    assert.equal(b.style.opacity, a.style.opacity, `${id} 透明度一致`);
  }
});

test('损坏/高版本工程载入时报错而不是返回空画面', () => {
  assert.throws(() => deserializeScene('{not json'), /合法 JSON/);
  assert.throws(() => deserializeScene({ schema: 'other', root: {} }), /schema/);
  assert.throws(
    () => deserializeScene({ schema: 'scene-graph-editor', version: 99, root: {} }),
    /版本/,
  );
});
