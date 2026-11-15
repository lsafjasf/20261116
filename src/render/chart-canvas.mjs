import { makeTimeScale } from '../core/view-model.mjs';

const COLORS = { S1: '#e45756', S2: '#4c78a8', S3: '#54a24b', S4: '#f58518' };
export const stationColor = (id) => COLORS[id];

const PANELS = [
  { field: 'tempC', label: '温度 (°C)', key: 'tempC' },
  { field: 'precipMm', label: '降水 (mm)', key: 'precipMm' },
  { field: 'windDirDeg', label: '风向 (°)', key: 'windDirDeg' }
];

// 纯 Canvas：ctx 由调用方传入，不触碰 DOM，便于 Node 下用桩上下文单测
export function drawChart(ctx, opts) {
  const { width, height, snapshot } = opts;
  const { window: win, cursorHour, clean, stats, selectedStations, manualMarks } = snapshot;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0f1623';
  ctx.fillRect(0, 0, width, height);

  const padding = { left: 52, right: 16, top: 28, bottom: 30 };
  const panelH = (height - padding.top - padding.bottom - 16) / 3;
  const scale = makeTimeScale(win, width, padding);

  PANELS.forEach((panel, pi) => {
    const top = padding.top + pi * (panelH + 8);
    drawPanel(ctx, { panel, top, panelH, padding, scale, win, cursorHour, width,
      clean, stats, selectedStations, manualMarks });
  });

  // 共享时间轴刻度（仅底部一份，体现同一条时间轴）
  ctx.fillStyle = '#9fb0c3';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  for (const hour of scale.ticks) {
    ctx.fillText(`${hour}`, scale.xForHour(hour), height - 10);
  }
  ctx.textAlign = 'left';
  return scale;
}

function drawPanel(ctx, o) {
  const { panel, top, panelH, padding, scale, win, cursorHour, width,
    clean, stats, selectedStations, manualMarks } = o;
  const baseY = top + panelH;
  const domain = panel.field === 'windDirDeg'
    ? [0, 360]
    : padDomain(stats.domains[panel.field]);

  ctx.strokeStyle = '#233047';
  ctx.lineWidth = 1;
  ctx.strokeRect(padding.left, top, width - padding.left - padding.right, panelH);

  ctx.fillStyle = '#c6d2e0';
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText(panel.label, padding.left, top - 8);
  ctx.font = '10px sans-serif';
  ctx.fillStyle = '#7d8ea3';
  ctx.fillText(`${domain[0]} ~ ${domain[1]}`, padding.left + 90, top - 8);

  const yFor = (v) => baseY - ((v - domain[0]) / (domain[1] - domain[0])) * panelH;

  // 网格
  ctx.strokeStyle = '#1b2740';
  for (let g = 0; g <= 4; g += 1) {
    const y = top + (panelH * g) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(scale.xForHour(win.end) + 0, y);
    ctx.stroke();
  }

  for (const stationId of selectedStations) {
    const series = clean.byStation[stationId];
    ctx.strokeStyle = COLORS[stationId];
    ctx.fillStyle = COLORS[stationId];
    ctx.lineWidth = 2;

    // 分段：遇到 null 断开，绝不跨空值连线
    let segment = [];
    for (let hour = win.start; hour <= win.end; hour += 1) {
      const v = series[hour].values[panel.field];
      if (v === null) {
        strokeSegment(ctx, segment, scale, yFor);
        segment = [];
      } else {
        segment.push({ hour, value: v });
      }
    }
    strokeSegment(ctx, segment, scale, yFor);

    for (let hour = win.start; hour <= win.end; hour += 1) {
      const v = series[hour].values[panel.field];
      if (v === null) {
        // 缺测占位符，明确区分“无数据”与 0
        ctx.strokeStyle = COLORS[stationId];
        ctx.beginPath();
        const x = scale.xForHour(hour);
        ctx.moveTo(x - 2, baseY - 4);
        ctx.lineTo(x + 2, baseY);
        ctx.moveTo(x + 2, baseY - 4);
        ctx.lineTo(x - 2, baseY);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(scale.xForHour(hour), yFor(v), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // 峰值标记（自动检测）
  for (const peak of stats.peaks) {
    if (peak.field !== panel.field || !selectedStations.includes(peak.stationId)) continue;
    const x = scale.xForHour(peak.hour);
    const y = yFor(peak.value);
    const stationIndex = selectedStations.indexOf(peak.stationId);
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.font = '10px sans-serif';
    const nearRight = x > width - 70;
    ctx.fillText('峰', nearRight ? x - 20 : x + 7, y - 6 - stationIndex * 9);
  }

  // 手动标记（三角）
  for (const mark of manualMarks) {
    if (mark.field !== panel.field || !selectedStations.includes(mark.stationId)) continue;
    const x = scale.xForHour(mark.hour);
    const y = yFor(mark.value);
    ctx.fillStyle = '#8ecae6';
    ctx.beginPath();
    ctx.moveTo(x, y - 9);
    ctx.lineTo(x - 5, y - 1);
    ctx.lineTo(x + 5, y - 1);
    ctx.closePath();
    ctx.fill();
  }

  // 游标竖线：三个面板同一条 x
  const cx = scale.xForHour(cursorHour);
  ctx.strokeStyle = '#e9f0fa';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx, baseY);
  ctx.stroke();
  ctx.setLineDash([]);
}

function strokeSegment(ctx, segment, scale, yFor) {
  if (segment.length === 0) return;
  ctx.beginPath();
  segment.forEach((p, i) => {
    const x = scale.xForHour(p.hour);
    const y = yFor(p.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function padDomain([lo, hi]) {
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.1;
  return [Math.floor(lo - pad), Math.ceil(hi + pad)];
}

