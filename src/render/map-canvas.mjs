import { STATIONS } from '../core/constants.mjs';
import { makeTimeScale } from '../core/view-model.mjs';
import { stationColor } from './chart-canvas.mjs';

export function drawMap(ctx, opts) {
  const { width, height, snapshot } = opts;
  const { window: win, cursorHour, clean, selectedStations } = snapshot;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#101a2c';
  ctx.fillRect(0, 0, width, height);

  const stripH = 34;
  const padding = { left: 40, right: 16, top: stripH + 14, bottom: 18 };
  const scale = makeTimeScale(win, width, padding);

  // 地图时间条：与曲线同一映射函数、同一窗口边界
  ctx.strokeStyle = '#243450';
  ctx.strokeRect(padding.left, 8, width - padding.left - padding.right, stripH - 14);
  ctx.fillStyle = '#9fb0c3';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  for (const hour of scale.ticks) {
    const x = scale.xForHour(hour);
    ctx.fillText(`${hour}`, x, stripH);
  }
  const cx = scale.xForHour(cursorHour);
  ctx.fillStyle = '#e9f0fa';
  ctx.fillRect(cx - 1, 8, 2, stripH - 14);
  ctx.textAlign = 'left';

  const mapW = width - padding.left - padding.right;
  const mapH = height - padding.top - padding.bottom;
  ctx.fillStyle = '#13243d';
  ctx.fillRect(padding.left, padding.top, mapW, mapH);
  ctx.strokeStyle = '#2c4266';
  ctx.strokeRect(padding.left, padding.top, mapW, mapH);

  for (const station of STATIONS) {
    const px = padding.left + station.x * mapW;
    const py = padding.top + station.y * mapH;
    const slot = clean.byStation[station.id][cursorHour];
    const selected = selectedStations.includes(station.id);

    // 云层：半径与不透明度随 cloudPct；缺测时仅画虚线环
    const cloud = slot.values.cloudPct;
    if (cloud !== null) {
      const r = 14 + cloud * 0.28;
      ctx.fillStyle = `rgba(200,214,229,${0.06 + cloud / 320})`;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(226,235,245,0.55)';
      ctx.beginPath();
      ctx.arc(px, py, 4 + cloud / 18, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#90a0b5';
      ctx.beginPath();
      ctx.arc(px, py, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 风向箭头：0° 为北（向上），顺时针；缺测不画箭头
    const dir = slot.values.windDirDeg;
    const spd = slot.values.windSpeedKmh;
    if (dir !== null && spd !== null) {
      drawArrow(ctx, px, py, dir, 8 + spd * 0.5, stationColor(station.id));
    }

    // 站点
    ctx.fillStyle = selected ? stationColor(station.id) : '#55657a';
    ctx.beginPath();
    ctx.arc(px, py, selected ? 5 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = selected ? '#e9f0fa' : '#8394a8';
    ctx.font = '11px sans-serif';
    ctx.fillText(`${station.id} ${station.name}`, px + 9, py - 7);
    if (!selected) ctx.fillText('（已筛选隐藏）', px + 9, py + 8);
  }

  ctx.fillStyle = '#7d8ea3';
  ctx.font = '10px sans-serif';
  ctx.fillText(`地图时间范围 = 窗口 [${win.start}:00 – ${win.end}:00]，游标 ${cursorHour}:00`,
    padding.left, height - 4);
  return scale;
}

function drawArrow(ctx, x, y, deg, len, color) {
  const rad = (deg - 90) * (Math.PI / 180); // 0° 朝上
  const x2 = x + Math.cos(rad) * len;
  const y2 = y + Math.sin(rad) * len;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const ah = 4;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(rad - 0.45) * ah, y2 - Math.sin(rad - 0.45) * ah);
  ctx.lineTo(x2 - Math.cos(rad + 0.45) * ah, y2 - Math.sin(rad + 0.45) * ah);
  ctx.closePath();
  ctx.fill();
}
