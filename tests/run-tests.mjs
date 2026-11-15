// 可重复测试：node tests/run-tests.mjs
// 三组：默认参数 / 边界参数 / 异常参数；另含锁定不变性与警告更新验证。
import {
  contrastRatio, deltaE, simulateVision, evaluatePair, hexToRgb, rgbToHex, THRESHOLDS,
} from '../js/color.js';
import {
  generateScheme, regenerateUnlocked, collectWarnings, exportCssVariables,
  createSnapshot, serializeState, deserializeState, hslToHex,
} from '../js/palette.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
function eq(a, b, name) { ok(a === b, `${name} (期望 ${b}，实际 ${a})`); }
function throws(fn, name) {
  try { fn(); failed++; console.error(`  FAIL ${name}（未抛错）`); }
  catch { passed++; console.log(`  PASS ${name}`); }
}

console.log('\n[组1] 默认参数');
{
  // 已知参考值：黑/白对比度 21，同色为 1
  eq(contrastRatio('#000000', '#ffffff'), 21, '黑白对比度 = 21');
  eq(contrastRatio('#336699', '#336699'), 1, '同色对比度 = 1');
  eq(deltaE('#ff0000', '#ff0000'), 0, '同色 ΔE = 0');
  ok(deltaE('#ff0000', '#00ff00') > 80, '红绿 ΔE 足够大');
  // 色觉模拟：红色在红色盲下应变暗
  const sim = simulateVision('#ff0000', 'protan');
  ok(hexToRgb(sim).r < 0xff, '红色经 protan 模拟后变暗');
  eq(simulateVision('#abcdef', 'normal'), '#abcdef', 'normal 模式原样返回');
  // 用途判定
  const good = evaluatePair('#000000', '#ffffff', 'normal');
  ok(good.smallText && good.button && good.chart, '黑白组合全用途通过');
  const bad = evaluatePair('#cc0000', '#009900', 'deutan');
  ok(!bad.chart, '深红深绿在绿色盲下图表不通过');
  ok(bad.chart !== evaluatePair('#cc0000', '#009900', 'normal').chart, '同一组合不同模式判定不同');
  // 方案生成可复现
  const s1 = generateScheme('Alpha', 42);
  const s2 = generateScheme('Alpha', 42);
  eq(serializeState(s1), serializeState(s2), '同种子生成结果一致');
  eq(s1.colors.length, 5, '默认 5 色');
}

console.log('\n[组2] 边界参数');
{
  eq(contrastRatio('#ffffff', '#ffffff'), 1, '白/白对比度下限 1');
  eq(hslToHex(360, 1, 0.5), hslToHex(0, 1, 0.5), '色相 360° 回绕到 0°');
  eq(hslToHex(-120, 2, -1), hslToHex(240, 1, 0), '饱和度/明度越界被钳制');
  eq(rgbToHex({ r: 300, g: -5, b: 128 }), '#ff0080', 'RGB 越界钳制');
  // 恰好处于阈值边界的组合
  const onThreshold = evaluatePair('#767676', '#ffffff', 'normal'); // 对比度 ≈ 4.54
  ok(onThreshold.contrast >= THRESHOLDS.smallText === onThreshold.smallText, '阈值边界判定自洽');
  // 全部锁定 / 全部未锁定
  const scheme = generateScheme('Beta', 7);
  scheme.colors.forEach((c) => { c.locked = true; });
  const allLocked = regenerateUnlocked(scheme, 999);
  eq(serializeState(allLocked.colors), serializeState(scheme.colors), '全部锁定后重生成不变');
  const noneLocked = regenerateUnlocked(generateScheme('Beta', 7), 999);
  ok(noneLocked.colors.every((c) => !c.locked), '全部未锁定可重生成');
  // 单色方案无配对警告
  eq(collectWarnings(generateScheme('Solo', 1, 1)).length, 0, '单色方案无警告');
}

console.log('\n[组3] 异常参数');
{
  throws(() => hexToRgb('not-a-color'), '非法 hex 抛错');
  throws(() => hexToRgb('#12345'), '5 位 hex 抛错');
  throws(() => hexToRgb(42), '非字符串 hex 抛错');
  throws(() => simulateVision('#ff0000', 'achromatopsia'), '未知视觉模式抛错');
  throws(() => evaluatePair('#000', '#fff', 'protanopia'), 'evaluatePair 未知模式抛错');
  throws(() => deserializeState('{"version":9}'), '未知状态版本抛错');
  throws(() => deserializeState('{"version":1,"schemes":[{"colors":[{"hex":"zzz"}],"order":[],"positions":[]}]}'), '损坏颜色抛错');
  throws(() => deserializeState('not json'), '非 JSON 抛错');
}

console.log('\n[验收] 锁定颜色不变 & 警告随组合更新');
{
  const scheme = generateScheme('Alpha', 42);
  scheme.colors[0].locked = true;
  scheme.colors[2].locked = true;
  const lockedBefore = scheme.colors.filter((c) => c.locked).map((c) => c.hex);
  const regen = regenerateUnlocked(scheme, 20261116);
  const lockedAfter = regen.colors.filter((c) => c.locked).map((c) => c.hex);
  eq(JSON.stringify(lockedAfter), JSON.stringify(lockedBefore), '锁定颜色重生成后不变');
  ok(regen.colors.some((c, i) => !c.locked && c.hex !== scheme.colors[i].hex), '未锁定颜色已更新');
  eq(JSON.stringify(regen.order), JSON.stringify(scheme.order), '图层顺序不变');
  eq(JSON.stringify(regen.positions), JSON.stringify(scheme.positions), '坐标不变');
  eq(JSON.stringify(regen.keyframes), JSON.stringify(scheme.keyframes), '关键帧不变');
  // 警告随组合更新
  const wBefore = collectWarnings(scheme);
  const wAfter = collectWarnings(regen);
  ok(JSON.stringify(wBefore) !== JSON.stringify(wAfter), '重生成后警告集合已更新');
  // 快照往返：重新载入后状态完全一致
  const snap = createSnapshot({ version: 1, activeScheme: 0, schemes: [regen] }, '导出前');
  const restored = deserializeState(serializeState(snap.state));
  eq(serializeState(restored), serializeState(snap.state), '快照序列化往返一致');
  // 导出与预览一致：CSS 变量顺序 = 图层顺序
  const css = exportCssVariables(regen);
  const cssHexes = [...css.matchAll(/: (#[0-9a-f]{6});/g)].map((m) => m[1]);
  const previewHexes = regen.order.map((id) => regen.colors.find((c) => c.id === id).hex);
  eq(JSON.stringify(cssHexes), JSON.stringify(previewHexes), 'CSS 导出顺序与预览一致');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
