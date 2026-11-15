/*
 * tests.js — 页内测试套件：普通 / 边界 / 失败 / 增量重算 / 加载重置 / 大图分块
 * 结果（哈希、对象数、截图对比、耗时）直接渲染到页面 #test-results。
 */
(function () {
  'use strict';
  var PC = globalThis.PipelineCore;
  var results = [];

  function yieldUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function addResult(name, category, pass, details, thumbs) {
    results.push({ name: name, category: category, pass: pass, details: details, thumbs: thumbs || [] });
    renderResults();
  }

  function renderResults() {
    var host = document.getElementById('test-results');
    host.innerHTML = '';
    var table = document.createElement('table');
    table.innerHTML = '<tr><th>场景</th><th>测试</th><th>结果</th><th>测量数据</th><th>截图</th></tr>';
    results.forEach(function (r) {
      var tr = document.createElement('tr');
      var tdC = document.createElement('td'); tdC.textContent = r.category;
      var tdN = document.createElement('td'); tdN.textContent = r.name;
      var tdP = document.createElement('td');
      tdP.textContent = r.pass ? '通过 ✓' : '失败 ✗';
      tdP.className = r.pass ? 'ok' : 'fail';
      var tdD = document.createElement('td');
      tdD.className = 'mono';
      tdD.textContent = r.details;
      var tdT = document.createElement('td');
      r.thumbs.forEach(function (t) {
        var img = document.createElement('img');
        img.src = t; img.className = 'thumb';
        tdT.appendChild(img);
      });
      tr.appendChild(tdC); tr.appendChild(tdN); tr.appendChild(tdP); tr.appendChild(tdD); tr.appendChild(tdT);
      table.appendChild(tr);
    });
    host.appendChild(table);
    var passed = results.filter(function (r) { return r.pass; }).length;
    document.getElementById('test-summary').textContent =
      '通过 ' + passed + ' / ' + results.length;
  }

  // 离屏运行一条完整管线，返回 { hash, runner }
  async function runOffscreen(image, nodes, tileH) {
    var runner = new PC.Runner(image.width, image.height, nodes, tileH || 64);
    runner.setSource(image.data);
    await runner.process(null, yieldUI);
    var hash = await PC.hashPixels(runner.finalBuffer());
    return { hash: hash, runner: runner };
  }

  // PNG 往返：buffer → canvas → toBlob → 解码 → hash
  async function pngRoundTripHash(buf, w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    var blob = await new Promise(function (res) { c.toBlob(res, 'image/png'); });
    var bmp = await createImageBitmap(blob);
    var c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    var ctx = c2.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return PC.hashPixels(ctx.getImageData(0, 0, w, h).data);
  }

  function thumbOf(buf, w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
    return c.toDataURL();
  }

  function cloneNodes(nodes) { return JSON.parse(JSON.stringify(nodes)); }

  function reorderNoiseFirst(nodes) {
    var n = cloneNodes(nodes);
    var i = n.findIndex(function (x) { return x.type === 'noise'; });
    var b = n.findIndex(function (x) { return x.type === 'blur'; });
    var tmp = n[i]; n[i] = n[b]; n[b] = tmp;
    return n;
  }
  // ---------- T1 普通场景：三张程序生成图 × 两种节点顺序 ----------
  async function testNormal(api) {
    var gens = globalThis.TestImages.generators;
    var names = ['gradient', 'checker', 'radial'];
    var allDiff = true, allExportMatch = true, lines = [], thumbs = [];
    for (var k = 0; k < names.length; k++) {
      var img = gens[names[k]](320, 200);
      var orderA = cloneNodes(api.demoA.nodes);
      var orderB = reorderNoiseFirst(orderA);
      var ra = await runOffscreen(img, orderA, 64);
      var rb = await runOffscreen(img, orderB, 64);
      var exportHash = await pngRoundTripHash(ra.runner.finalBuffer(), img.width, img.height);
      var diff = ra.hash !== rb.hash;
      var match = exportHash === ra.hash;
      allDiff = allDiff && diff;
      allExportMatch = allExportMatch && match;
      lines.push(names[k] + ': A=' + ra.hash.slice(0, 10) + ' B=' + rb.hash.slice(0, 10) +
        ' 顺序影响=' + (diff ? '是' : '否') + ' PNG一致=' + (match ? '是' : '否'));
      if (k === 0) { thumbs.push(thumbOf(ra.runner.finalBuffer(), img.width, img.height)); thumbs.push(thumbOf(rb.runner.finalBuffer(), img.width, img.height)); }
    }
    addResult('三图×两序：顺序改变哈希、导出==预览', '普通', allDiff && allExportMatch, lines.join('\n'), thumbs);
  }

  // ---------- T2 边界场景 ----------
  async function testBoundary(api) {
    var tiny = globalThis.TestImages.generators.tiny();
    // 2x2 图 + 零半径模糊 + 零噪点 → 恒等链
    var identity = [
      { id: 'a', type: 'levels', enabled: true, params: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 } },
      { id: 'b', type: 'blur', enabled: true, params: { radius: 0 } },
      { id: 'c', type: 'noise', enabled: true, params: { amount: 0, seed: 1, mono: false } },
      { id: 'd', type: 'tonemap', enabled: false, params: { exposure: 1, operator: 'reinhard' } }
    ];
    var r1 = await runOffscreen(tiny, identity, 1);
    var srcHash = await PC.hashPixels(tiny.data);
    var identityOk = r1.hash === srcHash;
    // 模糊半径(20)远大于 2x2 图 → 不崩溃且完成
    var big = cloneNodes(identity);
    big[1].params.radius = 20;
    var crashed = false;
    try { await runOffscreen(tiny, big, 1); } catch (e) { crashed = true; }
    // 1 行高图（tileH 大于图高）
    var line = globalThis.TestImages.makeImage(64, 1, 'line', function (x) { return [x * 4, 128, 255 - x * 4]; });
    var r3 = await runOffscreen(line, identity, 64);
    var lineOk = r3.runner.stats.tiles === 1;
    addResult('2x2恒等链 / 超半径模糊 / 单行图', '边界',
      identityOk && !crashed && lineOk,
      '恒等链==源: ' + identityOk + ' | 超半径崩溃: ' + crashed + ' | 单行图分块=1: ' + lineOk +
      '\nsrc=' + srcHash.slice(0, 10) + ' out=' + r1.hash.slice(0, 10),
      [thumbOf(r1.runner.finalBuffer(), 2, 2)]);
  }

  // ---------- T3 失败场景 ----------
  async function testFailure(api) {
    var before = api.state.lastPreviewHash;
    // 损坏的预设 JSON → 恢复为空且不抛异常
    api.corruptPresets();
    var threw = false;
    try { api.reloadPresets(); } catch (e) { threw = true; }
    var recovered = Object.keys(api.getPresets()).length === 0;
    // 非法参数（NaN/负值）→ 钳制后管线照常完成
    var img = globalThis.TestImages.generators.gradient(64, 64);
    var bad = [
      { id: 'a', type: 'levels', enabled: true, params: { inBlack: NaN, inWhite: -5, gamma: 0, outBlack: 0, outWhite: 255 } },
      { id: 'b', type: 'blur', enabled: true, params: { radius: -3 } },
      { id: 'c', type: 'noise', enabled: true, params: { amount: 'x', seed: 1 } },
      { id: 'd', type: 'tonemap', enabled: true, params: { exposure: NaN, operator: 'exp' } }
    ];
    var crashed = false, h = '';
    try {
      var r = await runOffscreen(img, bad, 16);
      h = r.hash;
    } catch (e) { crashed = true; }
    var stateIntact = api.state.lastPreviewHash === before;
    addResult('损坏预设 / 非法参数钳制', '失败',
      !threw && recovered && !crashed && stateIntact,
      '预设恢复: ' + recovered + ' | 未抛异常: ' + !threw +
      ' | 非法参数仍出图: ' + (h ? h.slice(0, 10) : '无') +
      ' | 主状态未污染: ' + stateIntact);
  }
  // ---------- T4 增量重算：只更新受影响区域，不重建场景对象 ----------
  async function testIncremental(api) {
    // 固定到演示状态A，保证可重复
    api.applyPresetData(api.demoA);
    await api.scheduleProcess();
    var hashBefore = api.state.lastPreviewHash;
    var countsBefore = JSON.stringify(api.objectCounts());
    var shotBefore = document.getElementById('canvas-result').toDataURL();

    // 1) 修改最后一个节点(tonemap)参数 → 只应从该节点起重算
    var lastIdx = api.state.nodes.length - 1;
    api.state.nodes[lastIdx].params.exposure = 1.6;
    api.state.runner.invalidateFrom(lastIdx);
    await api.scheduleProcess();
    var s1 = api.state.runner.stats;
    var fromNodeOk = s1.nodeRuns === s1.tiles * 1; // 每块只跑 1 个算子（tonemap）
    var hashAfterParam = api.state.lastPreviewHash;
    var paramChangedPixels = hashAfterParam !== hashBefore;

    // 2) 相同参数再重算 → 哈希/截图不变（幂等），对象数不变
    var shotAfterParam = document.getElementById('canvas-result').toDataURL();
    var countsMid = JSON.stringify(api.objectCounts());
    api.state.runner.invalidateFrom(lastIdx);
    await api.scheduleProcess();
    var hashRecompute = api.state.lastPreviewHash;
    var countsAfter = JSON.stringify(api.objectCounts());
    var shotRecompute = document.getElementById('canvas-result').toDataURL();
    var idempotent = hashRecompute === hashAfterParam;
    var countsStable = countsBefore === countsMid && countsMid === countsAfter;
    var shotStable = shotRecompute === shotAfterParam;

    // 3) 局部区域失效 → 分块数少于全图
    var fullTiles = Math.ceil(api.state.image.height / 50);
    api.state.runner.invalidateFrom(0, { x0: 100, y0: 100, x1: 200, y1: 160 });
    await api.scheduleProcess();
    var partialTiles = api.state.runner.stats.tiles;
    var partialOk = partialTiles < fullTiles;

    addResult('参数变化仅重算受影响节点/区域', '增量',
      fromNodeOk && paramChangedPixels && idempotent && countsStable && partialOk && shotStable,
      '改末节点: 算子/块=' + (s1.nodeRuns / Math.max(1, s1.tiles)) + ' (期望1)' +
      ' | 像素已变: ' + paramChangedPixels +
      '\n重算幂等: ' + idempotent + ' | 对象数稳定: ' + countsStable + ' (' + countsAfter + ')' +
      '\n局部区域分块: ' + partialTiles + ' < 全图 ' + fullTiles + ': ' + partialOk +
      ' | 重算截图一致: ' + shotStable +
      '\n前=' + hashBefore.slice(0, 10) + ' 改后=' + hashAfterParam.slice(0, 10) + ' 重算=' + hashRecompute.slice(0, 10),
      [shotBefore, shotRecompute]);
  }

  // ---------- T5 加载与重置 ----------
  async function testLoadReset(api) {
    // 保存当前(演示A)为预设 → 改参数 → 加载预设 → 哈希复原
    api.applyPresetData(api.demoA);
    await api.scheduleProcess();
    var demoHash = api.state.lastPreviewHash;
    api.savePresetData('__test__', {
      image: api.state.imageName,
      nodes: cloneNodes(api.state.nodes),
      previewHash: demoHash
    });
    api.state.nodes[0].params.gamma = 2.5;
    api.state.runner.invalidateFrom(0);
    await api.scheduleProcess();
    var modifiedHash = api.state.lastPreviewHash;
    var p = api.getPresets()['__test__'];
    api.applyPresetData(p);
    await api.scheduleProcess();
    var loadedHash = api.state.lastPreviewHash;
    var loadOk = loadedHash === p.previewHash && loadedHash !== modifiedHash;
    // 重置 → 与“全新默认”离屏哈希一致
    api.resetAll();
    await api.scheduleProcess();
    var freshImg = globalThis.TestImages.generators.gradient(
      api.state.image.width, api.state.image.height);
    var ref = await runOffscreen(freshImg, api.defaultNodes(), 50);
    var resetOk = api.state.lastPreviewHash === ref.hash;
    api.deletePresetData('__test__');
    addResult('保存→修改→加载复原 / 重置==默认', '加载重置',
      loadOk && resetOk,
      '演示=' + demoHash.slice(0, 10) + ' 修改=' + modifiedHash.slice(0, 10) +
      ' 加载=' + loadedHash.slice(0, 10) + '\n重置后==默认参考: ' + resetOk);
  }

  // ---------- T6 大图分块不阻塞 ----------
  async function testLargeImage() {
    var big = globalThis.TestImages.generators.radial(1600, 1200);
    var nodes = cloneNodes(globalThis.App.demoA.nodes);
    var runner = new PC.Runner(big.width, big.height, nodes, 64);
    runner.setSource(big.data);
    var yielded = false;
    var watcher = setTimeout(function () { yielded = true; }, 0);
    var t0 = performance.now();
    await runner.process(null, yieldUI);
    var total = performance.now() - t0;
    clearTimeout(watcher);
    // 分块结果必须与整图单次（tileH=图高）一致
    var single = await runOffscreen(big, nodes, big.height);
    var tiledHash = await PC.hashPixels(runner.finalBuffer());
    var same = tiledHash === single.hash;
    addResult('1600×1200 分块处理且让出事件循环', '大图',
      runner.stats.tiles > 1 && yielded && same,
      '分块=' + runner.stats.tiles + ' | 让出UI: ' + yielded +
      ' | 最长阻塞=' + runner.stats.longestBlockMs.toFixed(1) + 'ms' +
      ' | 总耗时=' + total.toFixed(0) + 'ms' +
      '\n分块==单次: ' + same + ' (' + tiledHash.slice(0, 10) + ')');
  }

  async function runAll(api) {
    results = [];
    renderResults();
    try {
      await testNormal(api);
      await testBoundary(api);
      await testFailure(api);
      await testIncremental(api);
      await testLoadReset(api);
      await testLargeImage();
    } catch (e) {
      addResult('套件异常', '失败', false, String(e && e.stack || e));
    }
    // 测试结束后恢复到演示状态A，保持交付画面一致
    api.restoreDemo('A');
    api.log('测试套件执行完毕');
  }

  globalThis.AppTests = { runAll: runAll };
})();
