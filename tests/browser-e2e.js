const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const ART = path.join(ROOT, 'artifacts');
const EXE = path.join('/home/hj/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');
let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    args: ['--no-sandbox', '--allow-file-access-from-files']
  });
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => window.__APP__ && window.__APP__.state);

  const state = () => page.evaluate(() => window.__APP__.state);

  console.log('页面基础与样例A');
  await check('页面无控制台错误', () => assert.strictEqual(consoleErrors.length, 0, consoleErrors.join('|')));
  await check('默认载入样例B且元信息显示数据版本', async () => {
    const s = await state();
    assert.strictEqual(s.sampleKey, 'B');
    const meta = await page.locator('#metaBar').innerText();
    assert.ok(meta.includes(s.cleanDataset.dataVersion));
    assert.ok(meta.includes('当前筛选'));
    assert.ok(meta.includes('导出口径'));
  });

  await page.selectOption('#sampleSelect', 'A');
  await check('样例A清洗台账为空且全部 tick 守恒', async () => {
    const s = await state();
    assert.strictEqual(s.cleanDataset.quarantine.length, 0);
    assert.ok(s.result.ledger.every((t) => t.conservationOk));
    assert.ok((await page.locator('#quarantineList').innerText()).includes('无需清洗'));
  });
  await page.screenshot({ path: path.join(ART, 'e2e-01-sampleA-tick0.png'), fullPage: false });

  console.log('样例B脏数据处理');
  await page.selectOption('#sampleSelect', 'B');
  await check('B 同时存在丢弃与修复记录', async () => {
    const s = await state();
    assert.ok(s.cleanDataset.stats.dropped > 0 && s.cleanDataset.stats.repaired > 0);
    const q = await page.locator('#quarantineList').innerText();
    assert.ok(q.includes('drop') && q.includes('repair'));
  });

  console.log('播放/暂停与地图渲染');
  await check('Canvas 已绘制且可暂停', async () => {
    await page.click('#playBtn');
    await page.waitForTimeout(1600);
    await page.click('#playBtn');
    const s = await state();
    assert.ok(s.playing === false && s.currentTick > 0);
  });
  await page.evaluate(() => { window.__APP__.state.currentTick = 12; window.__APP__.renderAll && window.__APP__.renderAll(); });
  await page.screenshot({ path: path.join(ART, 'e2e-02-outage-tick12.png') });

  console.log('断供改道验证');
  const shortage = async (apply, from, to, id) => page.evaluate((cfg) => {
    const st = window.__APP__.state;
    st.simulationOptions.applyInterventions = cfg.apply;
    st.rerun();
    return st.result.ledger.slice(cfg.from, cfg.to + 1)
      .reduce((a, t) => a + t.nodes.find((n) => n.id === cfg.id).shortage, 0);
  }, { apply, from, to, id });
  const baseShort = await shortage(false, 14, 19, 'S1');
  const fixShort = await shortage(true, 14, 19, 'S1');
  await check('部分断供窗口改道消除缺货（基线 ' + baseShort + ' → 改道 ' + fixShort + '）', () => {
    assert.ok(baseShort >= 60 && fixShort === 0);
  });
  await check('改道后 W1 库存同步回补且 S1 需求全满足', async () => {
    const s = await state();
    const win = s.result.ledger.slice(14, 20);
    win.forEach((t) => {
      const s1 = t.nodes.find((n) => n.id === 'S1');
      assert.strictEqual(s1.met, s1.demand);
      assert.ok(s1.inv >= 0);
    });
    assert.ok(s.result.ledger[17].nodes.find((n) => n.id === 'W1').inv >
      s.result.ledger[13].nodes.find((n) => n.id === 'W1').inv * 3);
  });
  await page.evaluate(() => {
    const st = window.__APP__.state;
    st.currentTick = 16;
    window.__APP__.renderAll();
  });
  await page.screenshot({ path: path.join(ART, 'e2e-03-reroute-tick16.png') });

  console.log('边编辑与满载高亮');
  await check('调小 E05 容量后立即重算并出现满载边', async () => {
    await page.selectOption('#edgeSelect', 'E05');
    await page.fill('#capInput', '1');
    await page.click('#applyEdgeBtn');
    const s = await state();
    assert.ok(s.edgeEdits.E05.cap === 1);
    assert.ok(s.result.ledger.some((t) => t.edges.find((e) => e.id === 'E05').overcap));
    const rows = await page.locator('#edgeTable tr.bad').count();
    assert.ok(rows > 0);
  });
  await page.screenshot({ path: path.join(ART, 'e2e-04-overcap-highlight.png') });
  await page.click('#resetEdgeBtn');

  console.log('筛选联动所有视图');
  await check('节点筛选同时影响地图与节点表', async () => {
    await page.selectOption('#nodeTypeFilter', 'store');
    const visible = await page.evaluate(() =>
      window.__APP__.state.visibleNodes(window.__APP__.state.tickState()));
    assert.strictEqual(visible.every((n) => n.type === 'store'), true);
    const rowCount = await page.locator('#nodeTable tbody tr').count();
    assert.strictEqual(rowCount, visible.length);
    await page.selectOption('#nodeTypeFilter', 'all');
  });

  console.log('调试面板');
  await check('调试面板含逐 tick 守恒与中间态', async () => {
    const dbgRows = await page.locator('#debugTable tbody tr').count();
    assert.strictEqual(dbgRows, (await state()).tickCount);
    const detail = await page.locator('#debugDetail').innerText();
    assert.ok(detail.includes('守恒恒等式') && detail.includes('满载边'));
  });

  console.log('导出往返一致性与工程存档');
  const [dl1] = await Promise.all([
    page.waitForEvent('download'), page.click('#exportNodeCsv')
  ]);
  const nodeCsvPath = await dl1.path();
  const [dl2] = await Promise.all([
    page.waitForEvent('download'), page.click('#exportEdgeCsv')
  ]);
  const edgeCsvPath = await dl2.path();
  const [dl3] = await Promise.all([
    page.waitForEvent('download'), page.click('#saveProjectBtn')
  ]);
  const projectPath = await dl3.path();
  await check('导出日志显示往返一致且对象数量匹配', async () => {
    const log = await page.locator('#exportLog').innerText();
    assert.ok(log.includes('往返一致'));
    const s = await state();
    const fs = require('fs');
    const nodeLines = fs.readFileSync(nodeCsvPath, 'utf8').trim().split('\n').length - 1;
    const edgeLines = fs.readFileSync(edgeCsvPath, 'utf8').trim().split('\n').length - 1;
    assert.strictEqual(nodeLines, s.checksums.nodeRowCount);
    assert.strictEqual(edgeLines, s.checksums.edgeRowCount);
  });

  const beforeChecksum = JSON.stringify((await state()).checksums);
  await page.setInputFiles('#loadProjectInput', projectPath);
  await page.waitForEvent('dialog').then((d) => d.accept()).catch(() => {});
  await check('工程重新载入后校验和完全一致', async () => {
    const after = JSON.stringify((await state()).checksums);
    assert.strictEqual(after, beforeChecksum);
  });
  await page.evaluate(() => {
    const st = window.__APP__.state;
    st.currentTick = 25;
    window.__APP__.renderAll();
  });
  await page.screenshot({ path: path.join(ART, 'e2e-05-recovered-tick25.png'), fullPage: true });

  console.log('音效开关');
  await check('音频可开关且不报错', async () => {
    await page.click('#audioBtn');
    const on = await page.evaluate(() => !window.__APP__.audio.muted);
    assert.strictEqual(on, true);
    assert.strictEqual(consoleErrors.length, 0);
  });

  await browser.close();
  console.log('\n浏览器端到端全部通过：' + passed + ' 项，截图位于 artifacts/');
})().catch((e) => { console.error(e); process.exit(1); });
