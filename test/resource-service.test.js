import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceService } from '../src/core/resource-service.js';

function makeBackend(versions = new Map()) {
  return async (key) => ({
    version: versions.get(key) ?? 1,
    payload: { key, data: `payload-of-${key}` },
  });
}

test('正常路径：首次走网络，二次命中缓存并完成版本校验', async () => {
  const svc = new ResourceService({ backend: makeBackend() });
  const first = await svc.getResource('tex/a');
  assert.equal(first.status, 'ok');
  assert.equal(first.source, 'network');
  const second = await svc.getResource('tex/a');
  assert.equal(second.source, 'cache-verified');
  assert.deepEqual(second.notices, []);
});

test('缓存失效后强制重新请求，不继续展示未校验的旧内容', async () => {
  const versions = new Map([['tex/a', 1]]);
  const svc = new ResourceService({ backend: makeBackend(versions) });
  await svc.getResource('tex/a');
  svc.invalidate('tex/a');
  versions.set('tex/a', 2);
  const refreshed = await svc.getResource('tex/a');
  assert.equal(refreshed.source, 'network');
  assert.equal(refreshed.version, 2);
});

test('后端请求失败且有缓存：回退过期缓存并明确提示', async () => {
  const svc = new ResourceService({
    backend: makeBackend(),
    faults: { 'tex/a': 'network' },
  });
  // 先正常拉一份
  svc.clearFault('tex/a');
  await svc.getResource('tex/a');
  svc.setFault('tex/a', 'network');
  const result = await svc.getResource('tex/a');
  assert.equal(result.status, 'fallback');
  assert.equal(result.source, 'stale-cache');
  assert.equal(result.value.data, 'payload-of-tex/a');
  assert.equal(result.notices[0].level, 'warning');
  assert.match(result.notices[0].message, /回退到最近缓存/);
});

test('后端失败且无缓存：回退内置占位图并明确提示，不返回空白', async () => {
  const svc = new ResourceService({
    backend: makeBackend(),
    faults: { 'tex/missing': 'timeout' },
  });
  const result = await svc.getResource('tex/missing');
  assert.equal(result.status, 'fallback');
  assert.equal(result.source, 'placeholder');
  assert.match(result.value.color, /^#[0-9a-f]{6}$/);
  assert.equal(result.notices[0].level, 'error');
  assert.match(result.notices[0].message, /占位图/);
});

test('损坏响应触发回退；缩略图失败回退占位缩略图', async () => {
  const svc = new ResourceService({
    backend: makeBackend(),
    faults: { 'tex/bad': 'corrupt' },
    thumbnailer: async () => {
      throw new Error('缩略图管线崩溃');
    },
  });
  const result = await svc.getResource('tex/bad');
  assert.equal(result.source, 'placeholder');
  const withThumb = await svc.getThumbnail('tex/good');
  assert.equal(withThumb.thumbnail.kind, 'placeholder');
  assert.ok(
    withThumb.notices.some((n) => n.code === 'THUMBNAIL_FAILED'),
    '应包含缩略图失败提示',
  );
});
