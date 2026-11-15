/*
 * app.js — UI：节点重排、参数、预设、导出、测量面板、状态摘要、一键恢复
 */
(function () {
  'use strict';
  var PC = globalThis.PipelineCore;
  var IMG_W = 640, IMG_H = 400, TILE_H = 50;

  // ---------- 默认节点定义 ----------
  function defaultNodes() {
    return [
      { id: 'n1', type: 'levels', enabled: true, params: { inBlack: 10, inWhite: 245, gamma: 1.1, outBlack: 0, outWhite: 255 } },
      { id: 'n2', type: 'blur', enabled: true, params: { radius: 3 } },
      { id: 'n3', type: 'noise', enabled: true, params: { amount: 12, seed: 7, mono: false } },
      { id: 'n4', type: 'tonemap', enabled: true, params: { exposure: 1.2, operator: 'reinhard' } }
    ];
  }

  // 交付用“可视化对照参数”：两种节点顺序的对照预设 + 算法状态摘要
  var DEMO_STATE = {
    image: 'gradient',
    nodes: [
      { id: 'n1', type: 'levels', enabled: true, params: { inBlack: 20, inWhite: 235, gamma: 1.25, outBlack: 0, outWhite: 255 } },
      { id: 'n2', type: 'noise', enabled: true, params: { amount: 24, seed: 42, mono: false } },
      { id: 'n3', type: 'blur', enabled: true, params: { radius: 4 } },
      { id: 'n4', type: 'tonemap', enabled: true, params: { exposure: 1.35, operator: 'filmic' } }
    ],
    note: '对照顺序A: levels→noise→blur→tonemap（先加噪再模糊，噪点被平滑）'
  };
  var DEMO_STATE_B = {
    image: 'gradient',
    nodes: [
      { id: 'n1', type: 'levels', enabled: true, params: { inBlack: 20, inWhite: 235, gamma: 1.25, outBlack: 0, outWhite: 255 } },
      { id: 'n2', type: 'blur', enabled: true, params: { radius: 4 } },
      { id: 'n3', type: 'noise', enabled: true, params: { amount: 24, seed: 42, mono: false } },
      { id: 'n4', type: 'tonemap', enabled: true, params: { exposure: 1.35, operator: 'filmic' } }
    ],
    note: '对照顺序B: levels→blur→noise→tonemap（先模糊再加噪，噪点保持颗粒）'
  };

  var NODE_LABELS = { levels: '色阶 Levels', blur: '模糊 Blur', noise: '噪点 Noise', tonemap: '色调映射 ToneMap' };

  // ---------- 应用状态 ----------
  var state = {
    nodes: defaultNodes(),
    imageName: 'gradient',
    image: null,       // {data,width,height,name}
    runner: null,
    processing: false,
    lastPreviewHash: '',
    lastExportHash: '',
    presets: {}
  };

  function $(id) { return document.getElementById(id); }

  function yieldToUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // ---------- 对象数量统计（验证重算不重建场景对象） ----------
  function objectCounts() {
    return {
      nodes: state.nodes.length,
      buffers: state.runner ? state.runner.buffers.length + 2 : 0, // 节点缓存 + src + tmp
      presets: Object.keys(state.presets).length,
      tiles: state.runner ? state.runner.stats.tiles : 0
    };
  }
  // ---------- 图像装载 ----------
  function loadImage(name) {
    var gen = globalThis.TestImages.generators[name];
    state.image = gen(IMG_W, IMG_H);
    state.imageName = name;
    state.runner = new PC.Runner(state.image.width, state.image.height, state.nodes, TILE_H);
    state.runner.setSource(state.image.data);
    var oc = $('canvas-original');
    oc.width = state.image.width; oc.height = state.image.height;
    var rc = $('canvas-result');
    rc.width = state.image.width; rc.height = state.image.height;
    var ctx = oc.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(state.image.data), state.image.width, state.image.height), 0, 0);
  }

  // ---------- 调度处理（分块、可取消、不阻塞 UI） ----------
  async function scheduleProcess() {
    if (state.processing) { state.runner.runToken++; } // 取消上一次
    var runner = state.runner;
    state.processing = true;
    state.lastExportHash = ''; // 新计算使旧导出哈希过期
    $('hash-export').textContent = '—';
    $('export-match').textContent = '';
    $('progress-bar').style.width = '0%';
    var totalRows = runner.dirty ? (runner.dirty.y1 - runner.dirty.y0) : 0;
    var doneRows = 0;
    var fromNode = runner.validCount;
    await runner.process(function (x0, y0, x1, y1, buf, w) {
      if (runner !== state.runner) return; // 旧任务回调，丢弃
      var rc = $('canvas-result');
      var ctx = rc.getContext('2d');
      var h = y1 - y0;
      var slice = new Uint8ClampedArray(w * h * 4);
      for (var r = 0; r < h; r++) {
        slice.set(buf.subarray((y0 + r) * w * 4, (y0 + r) * w * 4 + w * 4), r * w * 4);
      }
      ctx.putImageData(new ImageData(slice, w, h), 0, y0);
      doneRows += h;
      $('progress-bar').style.width = Math.round(100 * doneRows / Math.max(1, totalRows)) + '%';
    }, yieldToUI);
    if (runner !== state.runner) return; // 已被新任务取代
    state.processing = false;
    await updateHashesAndMeasurements(fromNode);
  }

  async function updateHashesAndMeasurements(fromNode) {
    var rc = $('canvas-result');
    var ctx = rc.getContext('2d');
    var px = ctx.getImageData(0, 0, rc.width, rc.height).data;
    state.lastPreviewHash = await PC.hashPixels(px);
    // 校验：画布像素与 Runner 最终缓冲必须逐像素一致
    var bufHash = await PC.hashPixels(state.runner.finalBuffer());
    var consistent = bufHash === state.lastPreviewHash;
    $('hash-preview').textContent = state.lastPreviewHash.slice(0, 16) + '…';
    $('consistency').textContent = consistent ? '一致 ✓（画布 == 数据）' : '不一致 ✗';
    $('consistency').className = consistent ? 'ok' : 'fail';
    var s = state.runner.stats;
    var oc = objectCounts();
    $('measurements').textContent =
      '起点节点: ' + fromNode + '/' + state.nodes.length +
      ' | 分块: ' + s.tiles + ' | 算子执行: ' + s.nodeRuns +
      ' | 像素: ' + s.pixels.toLocaleString() +
      '\n总耗时: ' + s.totalMs.toFixed(1) + 'ms | 最长单次阻塞: ' + s.longestBlockMs.toFixed(1) + 'ms' +
      '\n对象数 — 节点: ' + oc.nodes + ' 缓冲: ' + oc.buffers + ' 预设: ' + oc.presets;
    renderStateSummary();
  }

  // ---------- 算法状态摘要 ----------
  function renderStateSummary() {
    var summary = {
      image: state.imageName,
      size: state.image ? [state.image.width, state.image.height] : null,
      tileHeight: TILE_H,
      nodeOrder: state.nodes.map(function (n) { return n.type + (n.enabled ? '' : '(off)'); }),
      params: state.nodes.map(function (n) { return n.params; }),
      previewHash: state.lastPreviewHash,
      exportHash: state.lastExportHash || null
    };
    $('state-summary').textContent = JSON.stringify(summary, null, 1);
  }
  // ---------- 节点列表 UI（渲染不触发重算；只有参数/顺序变化才触发） ----------
  var dragIndex = null;

  function paramControl(node, key, label, min, max, step) {
    var wrap = document.createElement('label');
    wrap.className = 'param';
    var span = document.createElement('span');
    span.textContent = label;
    var input = document.createElement('input');
    input.type = 'range'; input.min = min; input.max = max; input.step = step;
    input.value = node.params[key];
    var val = document.createElement('em');
    val.textContent = node.params[key];
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      if (!isFinite(v)) v = min; // 失败场景防护：非法输入钳制
      node.params[key] = v;
      val.textContent = v;
      var idx = state.nodes.indexOf(node);
      state.runner.invalidateFrom(idx); // 仅从该节点起重算
      scheduleProcess();
    });
    wrap.appendChild(span); wrap.appendChild(input); wrap.appendChild(val);
    return wrap;
  }

  function nodeParamsUI(node) {
    var box = document.createElement('div');
    box.className = 'params';
    if (node.type === 'levels') {
      box.appendChild(paramControl(node, 'inBlack', '黑场', 0, 254, 1));
      box.appendChild(paramControl(node, 'inWhite', '白场', 1, 255, 1));
      box.appendChild(paramControl(node, 'gamma', '伽马', 0.2, 3, 0.05));
    } else if (node.type === 'blur') {
      box.appendChild(paramControl(node, 'radius', '半径', 0, 20, 1));
    } else if (node.type === 'noise') {
      box.appendChild(paramControl(node, 'amount', '强度', 0, 128, 1));
      box.appendChild(paramControl(node, 'seed', '种子', 1, 99, 1));
    } else if (node.type === 'tonemap') {
      box.appendChild(paramControl(node, 'exposure', '曝光', 0.1, 4, 0.05));
      var sel = document.createElement('select');
      ['reinhard', 'exp', 'filmic'].forEach(function (op) {
        var o = document.createElement('option');
        o.value = op; o.textContent = op;
        if (node.params.operator === op) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        node.params.operator = sel.value;
        state.runner.invalidateFrom(state.nodes.indexOf(node));
        scheduleProcess();
      });
      box.appendChild(sel);
    }
    return box;
  }

  function renderNodeList() {
    var list = $('node-list');
    list.innerHTML = '';
    state.nodes.forEach(function (node, i) {
      var card = document.createElement('div');
      card.className = 'node-card';
      card.draggable = true;
      var head = document.createElement('div');
      head.className = 'node-head';
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = node.enabled;
      cb.addEventListener('change', function () {
        node.enabled = cb.checked;
        state.runner.invalidateFrom(i);
        scheduleProcess();
      });
      var title = document.createElement('strong');
      title.textContent = (i + 1) + '. ' + NODE_LABELS[node.type];
      var up = document.createElement('button'); up.textContent = '↑';
      var down = document.createElement('button'); down.textContent = '↓';
      up.addEventListener('click', function () { moveNode(i, i - 1); });
      down.addEventListener('click', function () { moveNode(i, i + 1); });
      head.appendChild(cb); head.appendChild(title); head.appendChild(up); head.appendChild(down);
      card.appendChild(head);
      card.appendChild(nodeParamsUI(node));
      card.addEventListener('dragstart', function () { dragIndex = i; });
      card.addEventListener('dragover', function (e) { e.preventDefault(); });
      card.addEventListener('drop', function (e) {
        e.preventDefault();
        if (dragIndex !== null && dragIndex !== i) moveNode(dragIndex, i);
        dragIndex = null;
      });
      list.appendChild(card);
    });
  }

  // 顺序变化 → 整条链失效（顺序是真实影响像素的结构变化）
  function moveNode(from, to) {
    if (to < 0 || to >= state.nodes.length) return;
    var n = state.nodes.splice(from, 1)[0];
    state.nodes.splice(to, 0, n);
    renderNodeList();
    state.runner.invalidateFrom(0);
    scheduleProcess();
  }
  // ---------- 预设（localStorage） ----------
  var PRESET_KEY = 'imgchain.presets.v1';

  function loadPresets() {
    try {
      state.presets = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}') || {};
    } catch (e) {
      state.presets = {};
      log('预设读取失败，已回退为空: ' + e.message);
    }
    renderPresetList();
  }

  function persistPresets() {
    localStorage.setItem(PRESET_KEY, JSON.stringify(state.presets));
  }

  function renderPresetList() {
    var sel = $('preset-list');
    sel.innerHTML = '';
    Object.keys(state.presets).forEach(function (name) {
      var o = document.createElement('option');
      o.value = name; o.textContent = name;
      sel.appendChild(o);
    });
  }

  function savePreset() {
    var name = $('preset-name').value.trim();
    if (!name) { log('预设名不能为空'); return; }
    state.presets[name] = {
      image: state.imageName,
      nodes: JSON.parse(JSON.stringify(state.nodes)),
      previewHash: state.lastPreviewHash
    };
    persistPresets();
    renderPresetList();
    log('预设已保存: ' + name);
  }

  function applyPresetData(p) {
    state.nodes = JSON.parse(JSON.stringify(p.nodes));
    loadImage(p.image || 'gradient');
    renderNodeList();
    scheduleProcess();
  }

  function loadPreset() {
    var name = $('preset-list').value;
    var p = state.presets[name];
    if (!p) { log('预设不存在: ' + name); return; }
    applyPresetData(p);
    log('预设已加载: ' + name);
  }

  function deletePreset() {
    var name = $('preset-list').value;
    if (state.presets[name]) {
      delete state.presets[name];
      persistPresets();
      renderPresetList();
      log('预设已删除: ' + name);
    }
  }

  function resetAll() {
    state.nodes = defaultNodes();
    loadImage('gradient');
    renderNodeList();
    scheduleProcess();
    log('已重置为默认状态');
  }

  function restoreDemo(which) {
    var demo = which === 'B' ? DEMO_STATE_B : DEMO_STATE;
    applyPresetData(demo);
    log('已一键恢复演示状态 ' + which + '：' + demo.note);
  }

  // ---------- 导出 PNG（与预览逐像素一致） ----------
  async function exportPNG() {
    var rc = $('canvas-result');
    var blob = await new Promise(function (res) { rc.toBlob(res, 'image/png'); });
    if (!blob) { log('导出失败：无法生成 PNG'); return; }
    // 回读校验：解码 PNG 再哈希，必须等于预览哈希
    var bmp = await createImageBitmap(blob);
    var tc = document.createElement('canvas');
    tc.width = bmp.width; tc.height = bmp.height;
    var tctx = tc.getContext('2d');
    tctx.drawImage(bmp, 0, 0);
    var decoded = tctx.getImageData(0, 0, tc.width, tc.height).data;
    state.lastExportHash = await PC.hashPixels(decoded);
    var match = state.lastExportHash === state.lastPreviewHash;
    $('hash-export').textContent = state.lastExportHash.slice(0, 16) + '…';
    $('export-match').textContent = match ? '导出 == 预览 ✓' : '导出 != 预览 ✗';
    $('export-match').className = match ? 'ok' : 'fail';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'result-' + state.lastPreviewHash.slice(0, 8) + '.png';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    renderStateSummary();
    log('PNG 已导出，哈希校验: ' + (match ? '通过' : '失败'));
  }

  function log(msg) {
    var el = $('log');
    var line = document.createElement('div');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    el.prepend(line);
  }
  // ---------- 初始化 ----------
  function init() {
    loadImage('gradient');
    renderNodeList();
    loadPresets();

    $('image-select').addEventListener('change', function (e) {
      loadImage(e.target.value);
      scheduleProcess();
    });
    $('btn-save-preset').addEventListener('click', savePreset);
    $('btn-load-preset').addEventListener('click', loadPreset);
    $('btn-delete-preset').addEventListener('click', deletePreset);
    $('btn-reset').addEventListener('click', resetAll);
    $('btn-restore-a').addEventListener('click', function () { restoreDemo('A'); });
    $('btn-restore-b').addEventListener('click', function () { restoreDemo('B'); });
    $('btn-export').addEventListener('click', exportPNG);
    $('btn-run-tests').addEventListener('click', function () {
      globalThis.AppTests.runAll(api);
    });

    scheduleProcess();
    log('就绪：默认管线已加载');
  }

  // 暴露给页内测试套件的接口
  var api = {
    state: state,
    loadImage: loadImage,
    scheduleProcess: scheduleProcess,
    applyPresetData: applyPresetData,
    resetAll: resetAll,
    restoreDemo: restoreDemo,
    objectCounts: objectCounts,
    defaultNodes: defaultNodes,
    demoA: DEMO_STATE,
    demoB: DEMO_STATE,
    savePresetData: function (name, p) { state.presets[name] = p; persistPresets(); renderPresetList(); },
    getPresets: function () { return state.presets; },
    corruptPresets: function () { localStorage.setItem(PRESET_KEY, '{broken json'); },
    reloadPresets: loadPresets,
    deletePresetData: function (name) {
      delete state.presets[name];
      persistPresets();
      renderPresetList();
    },
    log: log
  };
  globalThis.App = api;

  document.addEventListener('DOMContentLoaded', init);
})();
