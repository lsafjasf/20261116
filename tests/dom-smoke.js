/* 浏览器链路冒烟测试：用最小 DOM/Canvas 桩驱动 app.js 的完整交互。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const listeners = {};
function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: 'all',
    style: {}, dataset: {}, files: [],
    classList: { add() {}, remove() {} },
    appendChild() {}, addEventListener(type, fn) {
      (listeners[id + ':' + type] = listeners[id + ':' + type] || []).push(fn);
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1180, height: 560 }; },
    click() {}, closest() { return null; }
  };
}

const els = {};
const canvasCalls = [];
const ctx2d = new Proxy({}, {
  get(t, prop) {
    if (prop === 'measureText') return () => ({ width: 40 });
    if (prop === 'createRadialGradient') return () => ({ addColorStop() {} });
    return typeof prop === 'string' ? function () {
      canvasCalls.push(prop);
      if (prop === 'getImageData') return { data: [0] };
    } : undefined;
  },
  set() { return true; }
});

const canvas = makeEl('flowCanvas');
canvas.getContext = () => ctx2d;

const elementIds = [
  'filterChip', 'versionChip', 'exportChip', 'conservedChip', 'summary',
  'nodeTable', 'edgeTable', 'debugPanel', 'detailPop', 'toast',
  'datasetSelect', 'shiftSelect', 'scaleRange', 'scaleValue', 'simBtn',
  'resetBtn', 'exportBtn', 'importInput'
];
elementIds.forEach((id) => { els[id] = makeEl(id); });

const store = {};
const sandbox = {
  console,
  localStorage: {
    setItem: (k, v) => { store[k] = v; },
    getItem: (k) => store[k] || null
  },
  Blob: function () {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  FileReader: function () {
    const self = this;
    this.readAsText = function (file) {
      self.result = file.content;
      self.onload({ target: self });
    };
  },
  devicePixelRatio: 1,
  setTimeout, clearTimeout,
  window: null,
  document: {
    getElementById: (id) => id === 'flowCanvas' ? canvas : (els[id] || makeEl(id)),
    createElement: () => makeEl('dyn'),
    addEventListener(type, fn) { listeners['doc:' + type] = fn; }
  }
};
sandbox.window = sandbox;
sandbox.module = undefined;
sandbox.addEventListener = function (type, fn) {
  (listeners['win:' + type] = listeners['win:' + type] || []).push(fn);
};
sandbox.self = sandbox;
vm.createContext(sandbox);

function load(rel) {
  let code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  // 纯浏览器环境：samples.js 的 CommonJS require 分支替换为全局 Core。
  code = code.replace("require('./core.js')", 'undefined');
  vm.runInContext(code, sandbox, { filename: rel });
}

load('js/core.js');
load('js/samples.js');
load('js/render.js');
load('js/app.js');
listeners['doc:DOMContentLoaded']();

const Core = sandbox.EnergyCore;
const state = { graph: () => {
  const saved = JSON.parse(store['factory-energy-flow-project-v1']);
  return saved.snapshot;
} };

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓ ' + name);
}

check('初始化后头部展示筛选/版本/导出口径',
  els.filterChip.innerHTML.includes('当前筛选') &&
  els.versionChip.innerHTML.includes(Core.VERSION) &&
  els.exportChip.innerHTML.includes(Core.EXPORT_SCHEMA));
check('调试面板渲染清洗中间状态与节点平衡',
  els.debugPanel.innerHTML.includes('计算流水线') &&
  els.debugPanel.innerHTML.includes('节点平衡'));
check('节点表 8 行、弧线表 22 行',
  (els.nodeTable.innerHTML.match(/<tr data-|<tr><td>/g) || []).length >= 8 &&
  (els.edgeTable.innerHTML.match(/data-edge/g) || []).length === 22);
check('Canvas 实际执行绘制调用', canvasCalls.includes('quadraticCurveTo') &&
  canvasCalls.includes('fillText'));
check('自动存档写入 localStorage', !!store['factory-energy-flow-project-v1']);

// 切换班次窗口并验证数值同步。
els.shiftSelect.value = 'night';
listeners['shiftSelect:change'].forEach((fn) =>
  fn.call(els.shiftSelect, { target: els.shiftSelect }));
const nightSnap = state.graph();
check('切换夜班后存档快照同步更新', nightSnap.parameters.shiftId === 'night');

// 运行输入减少仿真。
listeners['simBtn:click'].forEach((fn) => fn.call(els.simBtn, {}));
const simSnap = state.graph();
check('仿真后输入缩放 0.8 且快照同步', simSnap.parameters.inputScale === 0.8);

// 导出对象数量与关键数值一致性（通过自动存档内容验证）。
const project = JSON.parse(store['factory-energy-flow-project-v1']);
const reload = Core.reloadProject(project);
check('导出/存档对象数量固定（8 节点 22 弧线）',
  project.snapshot.objectCounts.nodes === 8 &&
  project.snapshot.objectCounts.edges === 22);
check('重新载入后对象数量与关键数值完全一致',
  reload.ok && reload.objectCountsMatch && reload.keyValuesMatch);

// 模拟导入工程（脏数据样例 B）。
const VmCore = sandbox.EnergyCore;
const samples = sandbox.EnergySamples.all();
const gB = VmCore.buildGraph({ records: samples[1].records, shiftId: 'all' });
const projectB = VmCore.makeProject(samples[1], {
  datasetId: samples[1].id, overrides: {}
}, gB);
els.importInput.files = [{ content: JSON.stringify(projectB) }];
listeners['importInput:change'].forEach((fn) =>
  fn.call(els.importInput, { target: els.importInput }));
check('导入样例 B 后数据集切换并完成重算',
  els.datasetSelect.value === 'sample-b');
check('导入成功提示且校验通过',
  els.toast.textContent.includes('工程载入成功'));

console.log('\nDOM 冒烟测试：' + passed + ' 通过，0 失败');
