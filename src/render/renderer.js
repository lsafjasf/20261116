import {
  computeWorldMatrices,
  findNode,
  effectiveVisibility,
  flattenDrawOrder,
} from '../core/scene.js';
import { identity } from '../core/math.js';

function drawShape(ctx, node) {
  const geo = node.geometry;
  if (!geo) return;
  ctx.globalAlpha = node.style.opacity;
  ctx.fillStyle = node.style.fill;
  ctx.beginPath();
  if (node.type === 'ellipse') {
    ctx.ellipse(geo.w / 2, geo.h / 2, geo.w / 2, geo.h / 2);
  } else {
    ctx.rect(-geo.w / 2, -geo.h / 2, geo.w, geo.h);
  }
  ctx.fill();
}

function drawNode(ctx, node, worldMatrices, options) {
  const visible = effectiveVisibility(options.root, node.id);
  if (!visible) return;
  const m = worldMatrices.get(node.id);
  ctx.save();
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  if (node.clipped) {
    const clip = node.clipRect;
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
  }
  drawShape(ctx, node);
  // 选中节点及其父链：用描边式高亮（虚拟画布以边框矩形表达）
  if (options.highlightIds?.has(node.id)) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = options.highlightColor ?? '#ffb020';
    const size = node.geometry ? Math.max(node.geometry.w, node.geometry.h) : 40;
    ctx.beginPath();
    ctx.rect(-size / 2 - 4, -size / 2 - 4, 8, 8);
    ctx.fill();
  }
  node.children.forEach((child) => drawNode(ctx, child, worldMatrices, options));
  ctx.restore();
}

export function renderScene(canvas, root, options = {}) {
  const width = options.width ?? canvas.width;
  const height = options.height ?? canvas.height;
  const ctx = canvas.getContext();
  const worldMatrices = computeWorldMatrices(root, identity());
  const drawOrder = flattenDrawOrder(root).map((n) => n.id);
  const visibleIds = drawOrder.filter((id) => effectiveVisibility(root, id));
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect?.(0, 0, width, height);
    if (!ctx.fillRect) {
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.fill();
    }
  }
  drawNode(ctx, root, worldMatrices, {
    root,
    highlightIds: options.highlightIds,
    highlightColor: options.highlightColor,
  });
  return {
    ctx,
    drawOrder,
    visibleIds,
    worldMatrices,
    width,
    height,
  };
}

// 节点本地几何在世界坐标下的包围盒（供检查器/命中测试使用）
export function nodeWorldBounds(root, id) {
  const matrices = computeWorldMatrices(root);
  const node = findNode(root, id);
  if (!node || !node.geometry) return null;
  const { w, h } = node.geometry;
  const m = matrices.get(id);
  const corners = [
    { x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 },
  ].map((p) => {
    const q = { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
    return q;
  });
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };
}
