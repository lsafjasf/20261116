import { LAYER_LABELS, legendForThresholds, round } from "./core.js";

export const CANVAS_SIZE = Object.freeze({ width: 1000, height: 560 });
const MAP_RECT = Object.freeze({ x: 12, y: 12, width: 976, height: 536 });

const TERRAIN_STOPS = [
  [0, "#31584b"],
  [0.2, "#587764"],
  [0.42, "#83966b"],
  [0.62, "#b4a372"],
  [0.8, "#d1bd95"],
  [1, "#f0e9d9"],
];

const SLOPE_STOPS = [
  [0, "#497765"],
  [0.16, "#79a16c"],
  [0.35, "#b6b561"],
  [0.56, "#dcae53"],
  [0.76, "#dd7e48"],
  [1, "#bb4b43"],
];

const ASPECT_STOPS = [
  [0, "#4e86c6"],
  [0.125, "#50a8a1"],
  [0.25, "#8bbb66"],
  [0.375, "#d7c65f"],
  [0.5, "#dc8a53"],
  [0.625, "#b96869"],
  [0.75, "#9074ad"],
  [0.875, "#6277b3"],
  [1, "#4e86c6"],
];

const FLOW_COLORS = {
  low: "#7894a4",
  mid: "#dfa33c",
  high: "#d65345",
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function mixColor(left, right, amount) {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  const t = clamp(amount, 0, 1);
  return `rgb(${Math.round(a.r + (b.r - a.r) * t)}, ${Math.round(
    a.g + (b.g - a.g) * t,
  )}, ${Math.round(a.b + (b.b - a.b) * t)})`;
}

function sampleStops(stops, amount) {
  const value = clamp(amount, 0, 1);
  for (let index = 1; index < stops.length; index += 1) {
    if (value <= stops[index][0]) {
      const [leftAt, leftColor] = stops[index - 1];
      const [rightAt, rightColor] = stops[index];
      const span = rightAt - leftAt || 1;
      return mixColor(leftColor, rightColor, (value - leftAt) / span);
    }
  }
  return stops[stops.length - 1][1];
}

function shadeCanvasColor(color, hillshade, strength = 0.62) {
  const source = color.startsWith("#")
    ? hexToRgb(color)
    : (() => {
        const match = color.match(/\d+/g);
        return match ? { r: Number(match[0]), g: Number(match[1]), b: Number(match[2]) } : null;
      })();
  if (!source) return color;
  const factor = 1 - strength / 2 + hillshade * strength;
  return `rgb(${Math.round(source.r * factor)}, ${Math.round(source.g * factor)}, ${Math.round(source.b * factor)})`;
}

function terrainRange(topology) {
  const values = topology.cells.map((cell) => cell.elevation);
  return { min: Math.min(...values), max: Math.max(...values) };
}

function cellColor(cell, layer, thresholds, range) {
  let color;
  if (layer === "terrain") {
    const amount = (cell.elevation - range.min) / (range.max - range.min || 1);
    color = sampleStops(TERRAIN_STOPS, amount);
  } else if (layer === "slope") {
    color = sampleStops(SLOPE_STOPS, cell.slopeDeg / 46);
  } else if (layer === "aspect") {
    color = sampleStops(ASPECT_STOPS, cell.aspectDeg / 360);
  } else if (cell.riskIndex >= thresholds.upper) {
    color = FLOW_COLORS.high;
  } else if (cell.riskIndex >= thresholds.lower) {
    color = FLOW_COLORS.mid;
  } else {
    color = FLOW_COLORS.low;
  }
  return shadeCanvasColor(color, cell.hillshade, layer === "terrain" ? 0.58 : 0.34);
}

function drawMapGrid(ctx, topology, ui) {
  const thresholds = {
    lower: Math.min(ui.thresholdA, ui.thresholdB),
    upper: Math.max(ui.thresholdA, ui.thresholdB),
  };
  const range = terrainRange(topology);
  const cellWidth = MAP_RECT.width / topology.cols;
  const cellHeight = MAP_RECT.height / topology.rows;

  ctx.save();
  ctx.fillStyle = "#1a2926";
  ctx.fillRect(0, 0, CANVAS_SIZE.width, CANVAS_SIZE.height);
  topology.cells.forEach((cell) => {
    const x = MAP_RECT.x + cell.col * cellWidth;
    const y = MAP_RECT.y + cell.row * cellHeight;
    ctx.fillStyle = cellColor(cell, ui.layer, thresholds, range);
    ctx.fillRect(x, y, cellWidth + 0.45, cellHeight + 0.45);
  });

  if (ui.showGrid) {
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.13)";
    ctx.lineWidth = 0.55;
    for (let col = 0; col <= topology.cols; col += 1) {
      const x = MAP_RECT.x + col * cellWidth;
      ctx.moveTo(x, MAP_RECT.y);
      ctx.lineTo(x, MAP_RECT.y + MAP_RECT.height);
    }
    for (let row = 0; row <= topology.rows; row += 1) {
      const y = MAP_RECT.y + row * cellHeight;
      ctx.moveTo(MAP_RECT.x, y);
      ctx.lineTo(MAP_RECT.x + MAP_RECT.width, y);
    }
    ctx.stroke();
  }
  ctx.restore();
  return { cellWidth, cellHeight };
}

function cellCenter(cell, cellWidth, cellHeight) {
  return {
    x: MAP_RECT.x + (cell.col + 0.5) * cellWidth,
    y: MAP_RECT.y + (cell.row + 0.5) * cellHeight,
  };
}

function drawStreamNetwork(ctx, topology, ui, cellWidth, cellHeight) {
  const threshold = topology.maxAccum * 0.055;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  topology.cells.forEach((cell) => {
    if (cell.flowAccum < threshold || !cell.downstreamId) return;
    const downstream = topology.byId.get(cell.downstreamId);
    if (!downstream) return;
    const start = cellCenter(cell, cellWidth, cellHeight);
    const end = cellCenter(downstream, cellWidth, cellHeight);
    const strength = clamp(cell.flowAccum / topology.maxAccum, 0.1, 1);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle =
      ui.layer === "flow"
        ? `rgba(255, 241, 214, ${0.22 + strength * 0.55})`
        : `rgba(130, 212, 227, ${0.2 + strength * 0.65})`;
    ctx.lineWidth = 0.7 + strength * 2.25;
    ctx.stroke();
  });
  ctx.restore();
}

function drawArrow(ctx, center, bearing, cellWidth, cellHeight, opts) {
  const radians = (bearing * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  const length = Math.min(cellWidth, cellHeight) * 0.23;
  const tailX = center.x - dx * length * 0.55;
  const tailY = center.y - dy * length * 0.55;
  const tipX = center.x + dx * length * 0.7;
  const tipY = center.y + dy * length * 0.7;
  const wingX = -dy * 0.32;
  const wingY = dx * 0.32;

  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tipX, tipY);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - dx * 3.1 + wingX * 2.8, tipY - dy * 3.1 + wingY * 2.8);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - dx * 3.1 - wingX * 2.8, tipY - dy * 3.1 - wingY * 2.8);
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = opts.width;
  ctx.stroke();
}

function drawArrows(ctx, topology, ui, cellWidth, cellHeight) {
  if (!ui.showArrows) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  topology.cells.forEach((cell) => {
    const bearing =
      ui.layer === "aspect" ? cell.aspectDeg : cell.flowDirDeg;
    if (bearing === null) return;
    const center = cellCenter(cell, cellWidth, cellHeight);
    drawArrow(ctx, center, bearing, cellWidth, cellHeight, {
      color: "rgba(9, 20, 17, 0.54)",
      width: 2.3,
    });
    drawArrow(ctx, center, bearing, cellWidth, cellHeight, {
      color:
        ui.layer === "flow" ? "rgba(255, 248, 231, 0.86)" : "rgba(255, 255, 255, 0.8)",
      width: 0.75,
    });
  });
  ctx.restore();
}

function drawDrainagePath(ctx, topology, selectedId, cellWidth, cellHeight) {
  if (!selectedId) return;
  const ids = [];
  const visited = new Set();
  let current = topology.byId.get(selectedId);
  while (current && !visited.has(current.id)) {
    ids.push(current.id);
    visited.add(current.id);
    current = current.downstreamId ? topology.byId.get(current.downstreamId) : null;
  }
  if (!ids.length) return;
  const points = ids.map((id) =>
    cellCenter(topology.byId.get(id), cellWidth, cellHeight),
  );
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = "rgba(6, 25, 23, 0.72)";
  ctx.lineWidth = 5.2;
  ctx.stroke();
  ctx.strokeStyle = "rgba(87, 225, 210, 0.96)";
  ctx.lineWidth = 2.2;
  ctx.stroke();
  points.slice(1).forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.7, 0, Math.PI * 2);
    ctx.fillStyle = "#65e3d2";
    ctx.fill();
    ctx.strokeStyle = "rgba(9, 34, 30, 0.8)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
  });
  ctx.restore();
}

function drawFocusCells(ctx, topology, ui, cellWidth, cellHeight) {
  const drawCellOutline = (cell, color, lineWidth, fillColor) => {
    if (!cell) return;
    const x = MAP_RECT.x + cell.col * cellWidth;
    const y = MAP_RECT.y + cell.row * cellHeight;
    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.fillRect(x + 1, y + 1, cellWidth - 2, cellHeight - 2);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.strokeRect(x + 1.5, y + 1.5, cellWidth - 3, cellHeight - 3);
  };

  if (ui.hoverId) {
    drawCellOutline(
      topology.byId.get(ui.hoverId),
      "rgba(255, 255, 255, 0.92)",
      1.3,
      "rgba(255, 255, 255, 0.09)",
    );
  }
  if (ui.selectedId) {
    const cell = topology.byId.get(ui.selectedId);
    drawCellOutline(cell, "#ffcb69", 2.2, "rgba(255, 196, 79, 0.12)");
    if (cell) {
      const center = cellCenter(cell, cellWidth, cellHeight);
      ctx.save();
      ctx.strokeStyle = "rgba(255, 218, 137, 0.95)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(center.x, center.y, 4.2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(center.x - 7, center.y);
      ctx.lineTo(center.x - 10, center.y);
      ctx.moveTo(center.x + 7, center.y);
      ctx.lineTo(center.x + 10, center.y);
      ctx.moveTo(center.x, center.y - 7);
      ctx.lineTo(center.x, center.y - 10);
      ctx.moveTo(center.x, center.y + 7);
      ctx.lineTo(center.x, center.y + 10);
      ctx.stroke();
      ctx.restore();
    }
  }
}

export function drawMap(ctx, topology, ui) {
  const { cellWidth, cellHeight } = drawMapGrid(ctx, topology, ui);
  drawStreamNetwork(ctx, topology, ui, cellWidth, cellHeight);
  drawArrows(ctx, topology, ui, cellWidth, cellHeight);
  drawDrainagePath(ctx, topology, ui.selectedId, cellWidth, cellHeight);
  drawFocusCells(ctx, topology, ui, cellWidth, cellHeight);
}

export function hitTestCanvas(topology, x, y) {
  if (
    x < MAP_RECT.x ||
    x > MAP_RECT.x + MAP_RECT.width ||
    y < MAP_RECT.y ||
    y > MAP_RECT.y + MAP_RECT.height
  ) {
    return null;
  }
  const col = Math.min(
    topology.cols - 1,
    Math.floor(((x - MAP_RECT.x) / MAP_RECT.width) * topology.cols),
  );
  const row = Math.min(
    topology.rows - 1,
    Math.floor(((y - MAP_RECT.y) / MAP_RECT.height) * topology.rows),
  );
  return topology.cells[row * topology.cols + col];
}

const TERRAIN_GRADIENT =
  "linear-gradient(90deg, #31584b, #83966b 42%, #d1bd95 80%, #f0e9d9)";
const SLOPE_GRADIENT =
  "linear-gradient(90deg, #497765, #b6b561 42%, #dd7e48 76%, #bb4b43)";
const ASPECT_GRADIENT =
  "linear-gradient(90deg, #4e86c6, #8bbb66 25%, #dc8a53 50%, #9074ad 75%, #4e86c6)";

export function renderLegend(container, topology, ui) {
  const thresholdLegend = legendForThresholds(topology, ui.thresholdA, ui.thresholdB);
  const layer = ui.layer;
  const riskMarkup = thresholdLegend
    .map(
      (item) =>
        `<span class="legend-item"><i class="legend-swatch" style="background:${item.color}"></i>${item.label} <b>${item.count}</b></span>`,
    )
    .join("");
  let layerGroup;
  if (layer === "flow") {
    layerGroup = `
      <div class="legend-group">
        <span>风险色带 · 当前阈值</span>
        <div class="legend-items">${riskMarkup}</div>
      </div>`;
  } else if (layer === "aspect") {
    layerGroup = `
      <div class="legend-group">
        <span>坡向 · 方位角</span>
        <div class="legend-gradient" style="background:${ASPECT_GRADIENT}"></div>
        <div class="legend-gradient-labels"><span>N 0°</span><span>E 90°</span><span>S 180°</span><span>W 270°</span><span>N 360°</span></div>
      </div>`;
  } else if (layer === "slope") {
    layerGroup = `
      <div class="legend-group">
        <span>坡度 · 度</span>
        <div class="legend-gradient" style="background:${SLOPE_GRADIENT}"></div>
        <div class="legend-gradient-labels"><span>0°</span><span>18°</span><span>30°</span><span>46°+</span></div>
      </div>`;
  } else {
    const range = terrainRange(topology);
    layerGroup = `
      <div class="legend-group">
        <span>高程 · m</span>
        <div class="legend-gradient" style="background:${TERRAIN_GRADIENT}"></div>
        <div class="legend-gradient-labels"><span>${Math.round(range.min)} m</span><span>${Math.round((range.min + range.max) / 2)} m</span><span>${Math.round(range.max)} m</span></div>
      </div>`;
  }
  container.innerHTML = `
    ${layerGroup}
    <div class="legend-group">
      <span>叠加要素</span>
      <div class="legend-items">
        <span class="legend-item"><i class="legend-swatch" style="background:#f8f4e8"></i>D8 箭头</span>
        <span class="legend-item"><i class="legend-swatch" style="background:#65e3d2"></i>排水路径</span>
        <span class="legend-item"><i class="legend-swatch" style="background:#86d4e3"></i>汇流线</span>
      </div>
    </div>`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawLegendGroup(ctx, x, y, title, items) {
  ctx.fillStyle = "#777d76";
  ctx.font = "600 15px 'Noto Sans SC', 'Segoe UI', sans-serif";
  ctx.fillText(title, x, y);
  let cursor = x;
  items.forEach((item) => {
    ctx.fillStyle = item.color;
    roundedRect(ctx, cursor, y + 16, 14, 14, 3);
    ctx.fill();
    ctx.fillStyle = "#37423d";
    ctx.font = "500 16px 'Noto Sans SC', 'Segoe UI', sans-serif";
    ctx.fillText(item.label, cursor + 22, y + 28);
    cursor += 32 + ctx.measureText(item.label).width;
  });
}

function truncateText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let output = text;
  while (output.length > 2 && ctx.measureText(`${output}…`).width > maxWidth) {
    output = output.slice(0, -1);
  }
  return `${output}…`;
}

export function createExportCanvas(topology, ui, auditSnapshot, exportedAt = new Date()) {
  const width = 1400;
  const height = 1180;
  const padding = 56;
  const mapWidth = width - padding * 2;
  const mapHeight = Math.round((mapWidth * CANVAS_SIZE.height) / CANVAS_SIZE.width);
  const mapY = 158;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#f2efe7";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#d96842";
  ctx.fillRect(0, 0, width, 7);

  ctx.fillStyle = "#1d2927";
  ctx.font = "700 38px 'Noto Sans SC', 'Segoe UI', sans-serif";
  ctx.fillText("地形汇流风险分析图", padding, 62);
  ctx.fillStyle = "#747b75";
  ctx.font = "600 13px 'Noto Sans SC', 'SFMono-Regular', monospace";
  ctx.fillText("TERRAIN / FLOW — EXPORT SHEET", padding, 87);

  ctx.fillStyle = "#1d2927";
  roundedRect(ctx, width - padding - 272, 35, 272, 52, 10);
  ctx.fill();
  ctx.fillStyle = "#f7f4ea";
  ctx.font = "700 18px 'Noto Sans SC', 'Segoe UI', sans-serif";
  ctx.fillText(`样例 ${topology.sample.code}  ${topology.sample.name}`, width - padding - 250, 67);

  ctx.fillStyle = "#69716b";
  ctx.font = "500 14px 'Noto Sans SC', 'Segoe UI', sans-serif";
  ctx.fillText(
    `数据版本 ${topology.revision}   ·   阈值 A ${ui.thresholdA}% / B ${ui.thresholdB}%   ·   ${LAYER_LABELS[ui.layer]}图层`,
    padding,
    119,
  );

  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = CANVAS_SIZE.width;
  mapCanvas.height = CANVAS_SIZE.height;
  drawMap(mapCanvas.getContext("2d"), topology, ui);
  ctx.save();
  roundedRect(ctx, padding, mapY, mapWidth, mapHeight, 12);
  ctx.clip();
  ctx.drawImage(mapCanvas, padding, mapY, mapWidth, mapHeight);
  ctx.restore();
  ctx.strokeStyle = "#26342f";
  ctx.lineWidth = 1.3;
  roundedRect(ctx, padding, mapY, mapWidth, mapHeight, 12);
  ctx.stroke();

  const legendY = mapY + mapHeight + 44;
  ctx.fillStyle = "#1d2927";
  ctx.font = "700 22px 'Noto Sans SC', 'Segoe UI', sans-serif";
  ctx.fillText("图例 / LEGEND", padding, legendY);
  ctx.fillStyle = "#d96842";
  ctx.fillRect(padding, legendY + 12, 44, 3);

  const riskItems = legendForThresholds(topology, ui.thresholdA, ui.thresholdB).map(
    (item) => ({
      color: item.color,
      label: `${item.label} · ${item.count} 格`,
    }),
  );
  drawLegendGroup(ctx, padding, legendY + 53, "风险色带", riskItems);
  drawLegendGroup(ctx, padding, legendY + 105, "叠加要素", [
    { color: "#f8f4e8", label: "D8 流向箭头" },
    { color: "#65e3d2", label: "选中排水路径" },
    { color: "#86d4e3", label: "汇流线" },
  ]);

  const metaX = width - padding - 410;
  ctx.fillStyle = "#1d2927";
  ctx.font = "700 22px 'Noto Sans SC', 'Segoe UI', sans-serif";
  ctx.fillText("导出口径 / AUDIT", metaX, legendY);
  ctx.fillStyle = "#687069";
  ctx.font = "500 14px 'Noto Sans SC', 'Segoe UI', sans-serif";
  const method =
    "风险指数 = log₁₊(汇流格−1) / log₁₊(最大汇流−1) × 100%；阈值色带按高风险/关注/低风险分级。";
  ctx.fillText(truncateText(ctx, method, 380), metaX, legendY + 31);
  ctx.fillStyle = "#37423d";
  ctx.font = "600 14px 'Noto Sans SC', 'SFMono-Regular', monospace";
  ctx.fillText(`对象 ${auditSnapshot.objectCount} · 网格 ${auditSnapshot.gridObjects}`, metaX, legendY + 58);
  ctx.fillText(
    `关键值 ${auditSnapshot.keyValues.elevation} / ${auditSnapshot.keyValues.flowDirection}`,
    metaX,
    legendY + 81,
  );

  ctx.strokeStyle = "#d4d0c4";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, height - 78);
  ctx.lineTo(width - padding, height - 78);
  ctx.stroke();
  ctx.fillStyle = "#7b817a";
  ctx.font = "500 12px 'Noto Sans SC', 'SFMono-Regular', monospace";
  ctx.fillText(
    `导出时间 ${exportedAt.toLocaleString("zh-CN", { hour12: false })}  ·  投影 本地笛卡尔  ·  网格 100 m  ·  原点 ${topology.sample.code}`,
    padding,
    height - 52,
  );
  ctx.textAlign = "right";
  ctx.fillText("TERRAIN / FLOW LAB", width - padding, height - 52);
  ctx.textAlign = "left";
  return canvas;
}

export function exportFilename(topology, ui) {
  return `terrain-flow_${topology.sample.code}_${ui.thresholdA}-${ui.thresholdB}.png`;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 编码失败"));
    }, "image/png");
  });
}

export { round };
