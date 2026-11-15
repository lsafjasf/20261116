/* core.js — 纯算法模块：路径平滑、标签避让、哈希、序列化。
 * 同时支持浏览器 (window.MapCore) 与 Node (module.exports)，便于双端测试。 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MapCore = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const EPS = 1e-9;

  /* ---------- 几何 ---------- */

  // Catmull-Rom 样条转三次贝塞尔，返回 SVG path d 字符串。
  // pts: [{x,y}, ...]；closed 时首尾闭合。少于 2 点返回空串。
  function smoothPathD(pts, closed) {
    if (!Array.isArray(pts) || pts.length < 2) return "";
    const p = pts.map((q) => ({ x: +q.x, y: +q.y }));
    for (const q of p) {
      if (!isFinite(q.x) || !isFinite(q.y)) {
        throw new Error("INVALID_POINT: 坐标含非有限数值");
      }
    }
    const n = p.length;
    const get = (i) => {
      if (closed) return p[((i % n) + n) % n];
      return p[Math.max(0, Math.min(n - 1, i))];
    };
    const last = closed ? n : n - 1;
    let d = `M ${r4(p[0].x)} ${r4(p[0].y)}`;
    for (let i = 0; i < last; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${r4(c1x)} ${r4(c1y)}, ${r4(c2x)} ${r4(c2y)}, ${r4(p2.x)} ${r4(p2.y)}`;
    }
    if (closed) d += " Z";
    return d;
  }

  function r4(v) { return Math.round(v * 10000) / 10000; }

  // 折线中点（按弧长），用于标签锚点
  function polylineMidpoint(pts) {
    if (pts.length === 0) return null;
    if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, angle: 0 };
    let total = 0;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      cum.push(total);
    }
    if (total < EPS) return { x: pts[0].x, y: pts[0].y, angle: 0 };
    const half = total / 2;
    for (let i = 1; i < cum.length; i++) {
      if (cum[i] >= half) {
        const t = (half - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
        const y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
        const angle = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
        return { x, y, angle };
      }
    }
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    return { x: b.x, y: b.y, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }

  /* ---------- 标签避让 ----------
   * 贪心放置：每个标签在锚点周围生成候选位置（环形 8 方向 × 2 距离档），
   * 逐一与已放置标签的包围盒做 AABB 相交测试，取第一个无碰撞候选；
   * 全部碰撞时退回到重叠面积最小的候选并记录 overflow。 */
  function placeLabels(items, opts) {
    const o = Object.assign({ pad: 4, dist1: 14, dist2: 26 }, opts || {});
    const placed = [];
    const results = [];
    let collisions = 0, overflows = 0;
    const dirs = [
      [0, -1], [1, -1], [1, 0], [1, 1],
      [0, 1], [-1, 1], [-1, 0], [-1, -1],
    ];
    for (const it of items) {
      const w = it.width, h = it.height;
      const candidates = [];
      for (const dist of [o.dist1, o.dist2]) {
        for (const pair of dirs) {
          const cx = it.anchor.x + pair[0] * dist;
          const cy = it.anchor.y + pair[1] * dist;
          candidates.push({ x: cx - w / 2, y: cy - h / 2, w, h, cx, cy });
        }
      }
      let best = null, bestOverlap = Infinity;
      for (const c of candidates) {
        let overlap = 0, hit = false;
        for (const q of placed) {
          const ov = aabbOverlap(c, q, o.pad);
          if (ov > 0) { hit = true; overlap += ov; }
        }
        if (!hit) { best = c; break; }
        if (overlap < bestOverlap) { bestOverlap = overlap; best = c; }
      }
      const collided = placed.some((q) => aabbOverlap(best, q, o.pad) > 0);
      if (collided) { collisions++; overflows++; }
      placed.push(best);
      results.push({
        id: it.id, text: it.text,
        x: best.x, y: best.y, w: best.w, h: best.h,
        cx: best.cx, cy: best.cy,
        collided,
      });
    }
    return { labels: results, stats: { total: items.length, collisions, overflows } };
  }

  function aabbOverlap(a, b, pad) {
    const p = pad || 0;
    const ox = Math.min(a.x + a.w + p, b.x + b.w + p) - Math.max(a.x - p, b.x - p);
    const oy = Math.min(a.y + a.h + p, b.y + b.h + p) - Math.max(a.y - p, b.y - p);
    return ox > 0 && oy > 0 ? ox * oy : 0;
  }

  // 估算文本包围盒（与渲染端共用同一估算，保证数据与画面一致）
  function measureText(text, fontSize) {
    const w = Math.max(1, String(text).length) * fontSize * 0.62;
    return { width: w, height: fontSize * 1.2 };
  }

  /* ---------- 哈希 ---------- */

  // FNV-1a 32bit，快速、同步、双端一致
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  // 场景几何指纹：只含世界坐标数据，不含任何渲染/可见性状态
  function sceneFingerprint(project) {
    const parts = [];
    for (const layer of project.layers) {
      parts.push(`L:${layer.id}`);
      for (const feat of layer.features) {
        const pts = feat.points.map((p) => `${r4(p.x)},${r4(p.y)}`).join(";");
        parts.push(`F:${feat.id}|${feat.closed ? 1 : 0}|${pts}`);
      }
    }
    return fnv1a(parts.join("#"));
  }

  /* ---------- 序列化 ---------- */

  const PROJECT_VERSION = 1;

  function serializeProject(project) {
    return JSON.stringify({
      version: PROJECT_VERSION,
      name: project.name || "untitled",
      layers: project.layers.map((l) => ({
        id: l.id, name: l.name, kind: l.kind, visible: !!l.visible,
        style: {
          width: l.style.width,
          lineJoin: l.style.lineJoin,
          color: l.style.color,
          dash: l.style.dash || null,
        },
        label: {
          text: l.label.text, show: !!l.label.show,
          fontSize: l.label.fontSize, color: l.label.color,
        },
        features: l.features.map((f) => ({
          id: f.id, closed: !!f.closed,
          points: f.points.map((p) => ({ x: r4(p.x), y: r4(p.y) })),
        })),
      })),
    }, null, 2);
  }

  // 解析并严格校验；失败抛出带原因的错误（失败场景测试依赖此行为）
  function deserializeProject(json) {
    let data;
    try {
      data = typeof json === "string" ? JSON.parse(json) : json;
    } catch (e) {
      throw new Error("PARSE_ERROR: 非法 JSON — " + e.message);
    }
    if (!data || typeof data !== "object") throw new Error("SCHEMA_ERROR: 根节点不是对象");
    if (data.version !== PROJECT_VERSION) {
      throw new Error(`VERSION_ERROR: 期望 ${PROJECT_VERSION}，实际 ${data.version}`);
    }
    if (!Array.isArray(data.layers)) throw new Error("SCHEMA_ERROR: layers 缺失");
    const layers = data.layers.map((l, li) => {
      if (!l.id || !Array.isArray(l.features)) {
        throw new Error(`SCHEMA_ERROR: 第 ${li} 层缺少 id/features`);
      }
      const features = l.features.map((f, fi) => {
        if (!Array.isArray(f.points) || f.points.length < 2) {
          throw new Error(`SCHEMA_ERROR: 要素 ${f.id || fi} 点数不足`);
        }
        const points = f.points.map((p) => {
          const x = +p.x, y = +p.y;
          if (!isFinite(x) || !isFinite(y)) {
            throw new Error(`DATA_ERROR: 要素 ${f.id || fi} 含非法坐标`);
          }
          return { x, y };
        });
        return { id: String(f.id), closed: !!f.closed, points };
      });
      return {
        id: String(l.id),
        name: String(l.name || l.id),
        kind: String(l.kind || "road"),
        visible: l.visible !== false,
        style: Object.assign({ width: 3, lineJoin: "round", color: "#888", dash: null }, l.style),
        label: Object.assign({ text: "", show: true, fontSize: 13, color: "#333" }, l.label),
        features,
      };
    });
    return { version: PROJECT_VERSION, name: String(data.name || "untitled"), layers };
  }

  /* ---------- 脏区计算 ----------
   * 给定变更描述，返回需要重算/重绘的最小集合，避免整场景重建。 */
  function dirtyScope(change) {
    switch (change.type) {
      case "node-move":
        return { layers: [change.layerId], features: [change.featureId], labels: true };
      case "style":
        return { layers: [change.layerId], features: null, labels: false };
      case "label-style":
        return { layers: [change.layerId], features: null, labels: true };
      case "visibility":
        return { layers: [change.layerId], features: null, labels: false, coordsFrozen: true };
      case "add-feature":
        return { layers: [change.layerId], features: [change.featureId], labels: true };
      default:
        return { layers: null, features: null, labels: true }; // 兜底全量
    }
  }

  return {
    smoothPathD, polylineMidpoint, placeLabels, measureText,
    fnv1a, sceneFingerprint, serializeProject, deserializeProject,
    dirtyScope, PROJECT_VERSION,
  };
});
