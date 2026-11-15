// Node 冒烟测试：用最小 DOM/Canvas 桩加载 game.js，跑若干帧并模拟按钮操作，
// 捕获 UI 层的引用错误与状态异常（真实渲染请在浏览器打开 index.html 查看）。
"use strict";

const listeners = {};
function makeCtx() {
  return new Proxy({}, {
    get: function (t, p) {
      if (p === "canvas") return {};
      return function () {};
    },
    set: function () { return true; },
  });
}
function makeEl(id) {
  return {
    id: id,
    textContent: "",
    innerHTML: "",
    className: "",
    style: {},
    children: [],
    scrollTop: 0,
    scrollHeight: 0,
    appendChild: function (c) { this.children.push(c); },
    getContext: function () { return makeCtx(); },
    set onclick(fn) { listeners[this.id] = fn; },
    get onclick() { return listeners[this.id]; },
    width: 900,
    height: 520,
  };
}
const els = {};
global.document = {
  getElementById: function (id) {
    if (!els[id]) els[id] = makeEl(id);
    return els[id];
  },
  createElement: function (tag) { return makeEl(tag + "_" + Math.random()); },
};
let rafCb = null;
global.requestAnimationFrame = function (cb) { rafCb = cb; };
global.window = global;

const ColdSim = require("./sim.js");
global.ColdSim = ColdSim;
global.ColdScenarios = require("./scenarios.js");

require("./game.js");

// 跑 500 帧（10x 速度下约 83 分钟仿真，覆盖完整一局）
let ts = 0;
for (let f = 0; f < 500; f++) {
  ts += 33;
  const cb = rafCb;
  rafCb = null;
  cb(ts);
  if (f === 10) listeners["defrost0"](); // 手动开始除霜
  if (f === 20) listeners["defrost0"](); // 停止
  if (f === 30) listeners["btnBackup"]();
  if (f === 40) listeners["btnDoor"]();
  if (f === 50) listeners["btnPause"](); // 暂停
  if (f === 55) listeners["btnStep"]();  // 单步
  if (f === 60) listeners["btnPause"](); // 恢复
  if (f === 70) listeners["btnSpeed"]();
  if (f === 80) listeners["btnReplay"](); // 失败回放
  if (f === 90) listeners["btnReset"]();
}
console.log("UI 冒烟测试通过：500 帧渲染 + 全部按钮操作无异常");
