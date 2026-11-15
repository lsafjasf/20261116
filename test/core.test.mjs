import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const C = require("../js/core.js");

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name, "\n", e.message); process.exitCode = 1; }
}

const sample = () => C.deserializeProject(C.serializeProject({
  name: "t",
  layers: [
    { id: "coast", name: "海岸线", kind: "coastline", visible: true,
      style: { width: 4, lineJoin: "round", color: "#1b6ca8", dash: null },
      label: { text: "海岸线", show: true, fontSize: 13, color: "#1b6ca8" },
      features: [{ id: "c1", closed: false, points: [{x:0,y:0},{x:50,y:30},{x:120,y:10}] }] },
    { id: "road", name: "道路", kind: "road", visible: true,
      style: { width: 3, lineJoin: "miter", color: "#c0392b", dash: null },
      label: { text: "主干道", show: true, fontSize: 13, color: "#c0392b" },
      features: [{ id: "r1", closed: false, points: [{x:10,y:80},{x:90,y:60},{x:160,y:90}] }] },
    { id: "admin", name: "行政边界", kind: "boundary", visible: true,
      style: { width: 2, lineJoin: "bevel", color: "#7d3c98", dash: "6 4" },
      label: { text: "边界", show: true, fontSize: 12, color: "#7d3c98" },
      features: [{ id: "b1", closed: true, points: [{x:20,y:20},{x:140,y:20},{x:140,y:110},{x:20,y:110}] }] },
  ],
}));

t("平滑路径生成贝塞尔曲线", () => {
  const d = C.smoothPathD([{x:0,y:0},{x:10,y:5},{x:20,y:0}], false);
  assert.match(d, /^M 0 0 C /);
  assert.ok(d.split("C").length - 1 === 2);
});

t("闭合路径以 Z 收尾且段数等于点数", () => {
  const d = C.smoothPathD([{x:0,y:0},{x:10,y:0},{x:10,y:10}], true);
  assert.ok(d.endsWith("Z"));
  assert.ok(d.split("C").length - 1 === 3);
});

t("节点移动后路径确定性重算（同输入同输出）", () => {
  const pts = [{x:0,y:0},{x:10,y:5},{x:20,y:0}];
  const a = C.smoothPathD(pts, false);
  pts[1] = { x: 10, y: 9 };
  const b = C.smoothPathD(pts, false);
  assert.notEqual(a, b);
  assert.equal(b, C.smoothPathD([{x:0,y:0},{x:10,y:9},{x:20,y:0}], false));
});

t("非有限坐标抛出 INVALID_POINT", () => {
  assert.throws(() => C.smoothPathD([{x:0,y:0},{x:NaN,y:1}], false), /INVALID_POINT/);
});

t("标签避让：密集锚点不产生重叠（可容纳时）", () => {
  const items = [];
  for (let i = 0; i < 4; i++) {
    items.push({ id: "t" + i, text: "标签" + i, anchor: { x: 100 + i * 30, y: 100 },
      ...C.measureText("标签" + i, 13) });
  }
  const { labels, stats } = C.placeLabels(items);
  assert.equal(stats.total, 4);
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(ox > 0 && oy > 0), `标签 ${i} 与 ${j} 重叠`);
    }
});

t("标签避让：极端拥挤时记录 overflow 而不崩溃", () => {
  const items = [];
  for (let i = 0; i < 40; i++) {
    items.push({ id: "x" + i, text: "拥挤标签" + i, anchor: { x: 50, y: 50 },
      ...C.measureText("拥挤标签" + i, 13) });
  }
  const { stats } = C.placeLabels(items);
  assert.ok(stats.overflows > 0);
});

t("序列化↔反序列化往返指纹一致", () => {
  const p1 = sample();
  const json = C.serializeProject(p1);
  const p2 = C.deserializeProject(json);
  assert.equal(C.sceneFingerprint(p1), C.sceneFingerprint(p2));
});

t("可见性开关不改变几何指纹", () => {
  const p = sample();
  const before = C.sceneFingerprint(p);
  p.layers[0].visible = false;
  const p2 = C.deserializeProject(C.serializeProject(p));
  assert.equal(C.sceneFingerprint(p2), before);
});

t("反序列化失败场景：坏 JSON / 坏版本 / 非法坐标", () => {
  assert.throws(() => C.deserializeProject("{not json"), /PARSE_ERROR/);
  assert.throws(() => C.deserializeProject('{"version":99,"layers":[]}'), /VERSION_ERROR/);
  assert.throws(() => C.deserializeProject(JSON.stringify({
    version: 1, layers: [{ id: "a", features: [{ id: "f", points: [{x:0,y:0},{x:"NaN",y:1}] }] }],
  })), /DATA_ERROR|SCHEMA_ERROR/);
});

t("脏区：节点移动只影响所在要素", () => {
  const s = C.dirtyScope({ type: "node-move", layerId: "road", featureId: "r1" });
  assert.deepEqual(s.layers, ["road"]);
  assert.deepEqual(s.features, ["r1"]);
  const v = C.dirtyScope({ type: "visibility", layerId: "coast" });
  assert.equal(v.coordsFrozen, true);
});

t("哈希稳定性", () => {
  assert.equal(C.fnv1a("abc"), C.fnv1a("abc"));
  assert.notEqual(C.fnv1a("abc"), C.fnv1a("abd"));
});

console.log(`\n${passed} 项核心测试通过`);
