// 无浏览器冒烟测试：桩掉 DOM/Canvas/Audio，跑 game.js 的初始化与若干帧
const handlers = {};
function el(id) {
  return {
    id, textContent: "", value: "20261116", width: 900, height: 560,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(t, f) { handlers[id + ":" + t] = f; },
    getContext() {
      return new Proxy({}, { get: (o, k) => (o[k] ??= (typeof k === "string" ? (() => {}) : undefined)) , set: (o,k,v)=>(o[k]=v,true) });
    },
  };
}
const els = {};
globalThis.document = { getElementById: (id) => (els[id] ??= el(id)) };
globalThis.window = {
  addEventListener(t, f) { handlers["win:" + t] = f; },
  AudioContext: undefined, webkitAudioContext: undefined,
};
let rafCb = null;
globalThis.requestAnimationFrame = (f) => { rafCb = f; };
let now = 0;
globalThis.performance = { now: () => now };

await import("./src/game.js");

// 模拟 5 秒实时飞行
for (let i = 0; i < 300; i++) { now += 16.7; const cb = rafCb; rafCb = null; cb(now); }
console.log("live frames ok, state:", els["sm-state"].textContent, "hash:", els["hash"].textContent);

// 模拟按键：拉杆触发失速
handlers["win:keydown"]({ key: "ArrowUp", preventDefault() {} });
for (let i = 0; i < 3000; i++) { now += 16.7; const cb = rafCb; rafCb = null; cb(now); }
console.log("after pitch-up, state:", els["sm-state"].textContent, "last:", els["sm-last"].textContent);
handlers["win:keyup"]({ key: "ArrowUp" });
handlers["win:keydown"]({ key: "ArrowDown", preventDefault() {} });
for (let i = 0; i < 2000; i++) { now += 16.7; const cb = rafCb; rafCb = null; cb(now); }
console.log("after push-over, state:", els["sm-state"].textContent);
handlers["win:keyup"]({ key: "ArrowDown" });

// 暂停 / 继续
handlers["win:keydown"]({ key: "p", preventDefault() {} });
console.log("paused:", els["sm-state"].textContent);
handlers["win:keydown"]({ key: "p", preventDefault() {} });
console.log("resumed:", els["sm-state"].textContent);

// 回放按钮
handlers["btn-replay:click"]();
for (let i = 0; i < 200; i++) { now += 16.7; const cb = rafCb; rafCb = null; cb(now); }
console.log("replay mode, state:", els["sm-state"].textContent);

// 重新开始（复位）
handlers["btn-restart:click"]();
console.log("after restart, state:", els["sm-state"].textContent, "fuel:", els["r-fuel"].textContent);
console.log("SMOKE OK");

// 补充：复位后跑帧确认计时器/资源/哈希真正归零
for (let i = 0; i < 10; i++) { now += 16.7; const cb = rafCb; rafCb = null; cb(now); }
console.log("post-restart frames, state:", els["sm-state"].textContent,
  "fuel:", els["r-fuel"].textContent, "hash:", els["hash"].textContent);
// 持续拉杆失速且不改出 -> 应走向失败（验证失速不可自动改出）
handlers["win:keydown"]({ key: "ArrowUp", preventDefault() {} });
for (let i = 0; i < 20000 && !els["sm-state"].textContent.includes("FAILED"); i++) {
  now += 16.7; const cb = rafCb; rafCb = null; cb(now);
}
console.log("held-stall outcome:", els["sm-state"].textContent, "|", els["overlay-detail"].textContent);
