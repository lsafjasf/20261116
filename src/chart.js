// Canvas rendering. One stacked panel per series with raw / cleaned /
// reference curves and a cleaned-vs-reference error band.

export const COLORS = {
  raw: '#d1495b',
  cleaned: '#2a9d8f',
  reference: '#3a6ea5',
  band: 'rgba(42,157,143,0.16)',
  grid: '#e3e6ea',
  text: '#444c56',
  fillFlag: 'rgba(209,73,91,0.18)',
  fillNull: 'rgba(58,110,165,0.16)'
};

const PADDING = { left: 56, right: 18, top: 30, bottom: 28 };

function drawLine(ctx, points, color, width, dash = []) {
  ctx.beginPath();
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  points.forEach((point, i) => {
    if (i === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.restore();
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
}

function drawPanel(ctx, opts) {
  const {
    x,
    y,
    width,
    height,
    title,
    seriesId,
    rows,
    pipeline,
    metrics
  } = opts;
  const plotW = width - PADDING.left - PADDING.right;
  const plotH = height - PADDING.top - PADDING.bottom;
  const originX = x + PADDING.left;
  const originY = y + PADDING.top;

  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    min = Math.min(min, row.values[seriesId], row.reference[seriesId]);
    max = Math.max(max, row.values[seriesId], row.reference[seriesId]);
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  const pad = (max - min) * 0.08 || 1;
  min -= pad;
  max += pad;

  const t0 = rows[0].timestamp;
  const t1 = rows[rows.length - 1].timestamp;
  const sx = (ts) => originX + ((ts - t0) / Math.max(1, t1 - t0)) * plotW;
  const sy = (value) =>
    originY + plotH - ((value - min) / Math.max(1e-9, max - min)) * plotH;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g += 1) {
    const gy = originY + (plotH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(originX, gy);
    ctx.lineTo(originX + plotW, gy);
    ctx.stroke();
    const value = max - ((max - min) * g) / 4;
    ctx.fillStyle = COLORS.text;
    ctx.font = '11px "Noto Sans SC", sans-serif';
    ctx.fillText(value.toFixed(1), x + 8, gy + 4);
  }

  const detail = pipeline.perSeries[seriesId];
  const flagTimes = new Set(
    detail.series.filter((e) => e.spike).map((e) => e.row.timestamp)
  );
  const nullTimes = new Set(
    detail.series.filter((e) => e.filled).map((e) => e.row.timestamp)
  );
  for (const row of rows) {
    if (flagTimes.has(row.timestamp)) {
      ctx.fillStyle = COLORS.fillFlag;
      ctx.fillRect(sx(row.timestamp) - 3, originY, 6, plotH);
    } else if (nullTimes.has(row.timestamp)) {
      ctx.fillStyle = COLORS.fillNull;
      ctx.fillRect(sx(row.timestamp) - 3, originY, 6, plotH);
    }
  }

  const rawPoints = [];
  const cleanedPoints = [];
  const referencePoints = [];
  const band = [];
  for (const row of rows) {
    const px = sx(row.timestamp);
    referencePoints.push({ x: px, y: sy(row.reference[seriesId]) });
    cleanedPoints.push({ x: px, y: sy(row.values[seriesId]) });
    band.push({ x: px, y: sy(row.values[seriesId]), y0: sy(row.reference[seriesId]) });
    const rawEntry = detail.series.find((e) => e.row.timestamp === row.timestamp);
    if (rawEntry && rawEntry.raw !== null) {
      rawPoints.push({ x: px, y: sy(rawEntry.raw) });
    }
  }

  ctx.beginPath();
  band.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  for (let i = band.length - 1; i >= 0; i -= 1) {
    ctx.lineTo(band[i].x, band[i].y0);
  }
  ctx.closePath();
  ctx.fillStyle = COLORS.band;
  ctx.fill();

  drawLine(ctx, referencePoints, COLORS.reference, 1.6, [6, 4]);
  drawLine(ctx, rawPoints, COLORS.raw, 1.4);
  drawLine(ctx, cleanedPoints, COLORS.cleaned, 2);

  ctx.fillStyle = COLORS.text;
  ctx.font = 'bold 12px "Noto Sans SC", sans-serif';
  ctx.fillText(
    `${title} · ${seriesId} · MAE ${metrics.mae} · 最大偏差 ${metrics.maxDev}`,
    originX,
    y + 16
  );
  ctx.font = '10px "Noto Sans SC", sans-serif';
  ctx.fillText(formatTime(t0), originX, y + height - 8);
  ctx.fillText(formatTime(t1), originX + plotW - 28, y + height - 8);
}

export function renderChart(canvas, state) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 960;
  const panelHeight = 190;
  const cssHeight = panelHeight * state.seriesIds.length + 16;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = cssHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#f6f8fa';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  state.seriesIds.forEach((seriesId, index) => {
    drawPanel(ctx, {
      x: 0,
      y: index * panelHeight + 8,
      width: cssWidth,
      height: panelHeight - 8,
      title: state.sampleId,
      seriesId,
      rows: state.windowRows,
      pipeline: state.pipeline,
      metrics: state.windowEvaluation.perSeries[seriesId]
    });
  });

  return {
    cssWidth,
    cssHeight,
    dataVersion: state.dataVersion,
    exportScope: state.exportScope
  };
}

// PNG export adds a metadata footer line so the downloaded file carries the
// exact export scope and data version shown in the UI.
export function exportPng(canvas, state) {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height + Math.round(28 * (window.devicePixelRatio || 1));
  const ctx = exportCanvas.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, canvas.height, exportCanvas.width, 28 * dpr);
  ctx.fillStyle = '#333';
  ctx.font = `${12 * dpr}px "Noto Sans SC", sans-serif`;
  const footer =
    `${state.exportScope.windowId} | ${state.dataVersion} | ` +
    `rows ${state.exportScope.counts.windowRows}/${state.exportScope.counts.cleanedRows} | ` +
    `MAE ${state.exportScope.metrics.mae} | max ${state.exportScope.metrics.maxDev}`;
  ctx.fillText(footer, 12 * dpr, canvas.height + 18 * dpr);
  return exportCanvas.toDataURL('image/png');
}
