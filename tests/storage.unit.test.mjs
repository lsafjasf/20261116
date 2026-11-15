import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateConfig, defaultConfig, canonicalJSON, hashConfig,
} from '../src/storage.js';

test('默认配置通过校验，非法颜色/枚举/数值被拒绝', () => {
  assert.equal(validateConfig(defaultConfig()).ok, true);
  const badColor = structuredClone(defaultConfig());
  badColor.colors.armorColor = 'blue';
  assert.match(validateConfig(badColor).error, /armorColor/);
  const badEnum = structuredClone(defaultConfig());
  badEnum.equipment.weapon = 'katana';
  assert.match(validateConfig(badEnum).error, /weapon/);
  const badRange = structuredClone(defaultConfig());
  badRange.animation.speed = 999;
  assert.match(validateConfig(badRange).error, /speed/);
  const unknown = structuredClone(defaultConfig());
  unknown.colors.hack = '#000000';
  assert.match(validateConfig(unknown).error, /未知字段/);
  assert.equal(validateConfig(null).ok, false);
});

test('canonicalJSON 字段顺序固定，颜色归一为小写', () => {
  const cfg = defaultConfig();
  const reordered = structuredClone(cfg);
  reordered.colors = { capeColor: cfg.colors.capeColor, armorColor: cfg.colors.armorColor.toUpperCase(), skinColor: cfg.colors.skinColor };
  const a = canonicalJSON(validateConfig(cfg).value);
  const b = canonicalJSON(validateConfig(reordered).value);
  assert.equal(a, b);
  assert.match(a, /"colors":\{"skinColor"/);
});

test('hashConfig 对同一配置稳定且对变化敏感', async () => {
  const cfg = defaultConfig();
  const h1 = await hashConfig(cfg);
  const h2 = await hashConfig(structuredClone(cfg));
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  const changed = structuredClone(cfg);
  changed.animation.bounce += 1;
  assert.notEqual(await hashConfig(changed), h1);
});
