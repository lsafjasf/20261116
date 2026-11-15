import { STATIONS, EXPORT_SPEC } from '../core/constants.mjs';
import { stationColor } from './chart-canvas.mjs';

const COLS = ['tempC', 'precipMm', 'windDirDeg', 'windSpeedKmh', 'cloudPct'];
const COL_LABEL = {
  tempC: '温度°C', precipMm: '降水mm', windDirDeg: '风向°',
  windSpeedKmh: '风速km/h', cloudPct: '云量%'
};

export function drawReadout(ctx, opts) {
  const { width, height, snapshot } = opts;
  const { dataset, readout, cursorHour, window: win, selectedStations } = snapshot;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0f1623';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#e9f0fa';
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText(`站点读数 · ${dataset.baseDate} ${String(cursorHour).padStart(2, '0')}:00`, 12, 22);

  // 页面要求展示：当前筛选、数据版本、导出口径
  ctx.font = '11px sans-serif';
  ctx.fillStyle = '#9fb0c3';
  ctx.fillText(`筛选：窗口[${win.start}-${win.end}时] 站点[${selectedStations.join(',')}]`, 12, 42);
  ctx.fillText(`数据版本：${dataset.version}`, 12, 58);
  ctx.fillText(`导出口径：${EXPORT_SPEC}（仅含筛选站点与当前窗口统计）`, 12, 74);

  const rows = readout;
  const x0 = 12;
  const y0 = 92;
  const rowH = 34;
  const colW = Math.floor((width - 24 - 70) / (COLS.length + 1));

  ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#c6d2e0';
  ctx.fillText('站点', x0 + 4, y0);
  COLS.forEach((c, i) => ctx.fillText(COL_LABEL[c], x0 + 70 + i * colW, y0));

  rows.forEach((row, ri) => {
    const y = y0 + 18 + ri * rowH;
    const hidden = !selectedStations.includes(row.stationId);
    ctx.globalAlpha = hidden ? 0.45 : 1;
    const station = STATIONS.find((s) => s.id === row.stationId);
    ctx.fillStyle = stationColor(row.stationId);
    ctx.beginPath();
    ctx.arc(x0 + 8, y - 4, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e9f0fa';
    ctx.font = '12px sans-serif';
    if (hidden) {
      ctx.fillStyle = '#8394a8';
      ctx.fillText(`${row.stationId} ${station.name}（已筛选隐藏）`, x0 + 18, y);
    } else {
      ctx.fillText(`${row.stationId} ${station.name}`, x0 + 18, y);
    }

    ctx.font = '11px sans-serif';
    if (!hidden) {
      COLS.forEach((field, ci) => {
        const x = x0 + 70 + ci * colW;
        const v = row.values[field];
        if (v === null) {
          const reason = row.reasons[field] === 'outlier' ? '异常隔离' : '缺测';
          ctx.fillStyle = row.reasons[field] === 'outlier' ? '#ff8f8f' : '#c9a86a';
          ctx.fillText(`${reason} · —`, x, y);
        } else {
          ctx.fillStyle = '#dfe8f2';
          ctx.fillText(String(v), x, y);
        }
      });
    }
    ctx.globalAlpha = 1;
  });

  ctx.fillStyle = '#6d7f95';
  ctx.font = '10px sans-serif';
  ctx.fillText('说明：空值与越界异常保留为空并标注，不做插值或连线伪造。', 12, height - 10);
}
