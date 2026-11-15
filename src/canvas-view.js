import { LAYERS } from './engine.js';

const STATE_COLORS = Object.freeze({
  calm: '#58c487',
  chase: '#f0b455',
  danger: '#ff6b6b',
});

const LAYER_COLORS = Object.freeze({
  ambient: '#6fb1ff',
  bass: '#b58bff',
  drums: '#ffcf6b',
  melody: '#5fe0c0',
});

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, Math.floor(rect.width));
  const height = Math.max(120, Math.floor(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

// Scrolling state band + intensity curve with threshold lines.
export function drawTrack(canvas, history, params = null) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0e13';
  ctx.fillRect(0, 0, width, height);

  const margin = 28;
  const plotH = height - margin * 2;
  const n = history.length;
  if (n < 2) {
    ctx.fillStyle = '#5b6777';
    ctx.fillText('等待数据…', 12, height / 2);
    return;
  }

  // State background bands.
  for (let i = 1; i < n; i++) {
    const x0 = ((i - 1) / (n - 1)) * width;
    const x1 = (i / (n - 1)) * width;
    ctx.fillStyle = STATE_COLORS[history[i].state] ?? '#333';
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x0, margin, x1 - x0 + 1, plotH);
    ctx.globalAlpha = 1;
  }

  // Threshold lines.
  if (params) {
    for (const [key, label] of [['thresholdCalmChase', 'C/C'], ['thresholdChaseDanger', 'C/D']]) {
      const y = margin + (1 - params[key]) * plotH;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '10px monospace';
      ctx.fillText(label, 4, y - 2);
    }
  }

  // Intensity polyline.
  ctx.strokeStyle = '#4f9cff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((point, i) => {
    const x = (i / (n - 1)) * width;
    const y = margin + (1 - point.intensity) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#8a97a8';
  ctx.font = '11px monospace';
  ctx.fillText('状态轨道 + 强度（右新左旧）', 8, 14);
  ctx.fillText(`当前: ${history[n - 1].state}`, width - 90, 14);
}

// Four stacked layer strips showing live time-domain waveform plus each
// layer's current bus gain, so scheduling vs. playback-chain issues are
// visually separable.
export function drawWaves(canvas, analyser, engine, history) {
  const { ctx, width, height } = fitCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b0e13';
  ctx.fillRect(0, 0, width, height);

  const labelW = 78;
  const stripH = height / LAYERS.length;
  let timeData = null;
  if (analyser) {
    timeData = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeData);
  }

  LAYERS.forEach((name, index) => {
    const top = index * stripH;
    const mid = top + stripH / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(0, top + 0.5, width, stripH - 1);

    ctx.fillStyle = LAYER_COLORS[name];
    ctx.font = '11px monospace';
    ctx.fillText(name, 8, top + 14);

    const gain = engine?.layerGain[name] ?? 0;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(`g:${gain.toFixed(2)}`, 8, top + 28);

    // Gain bar.
    const barX = labelW;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(barX, top + 8, 60, 6);
    ctx.fillStyle = LAYER_COLORS[name];
    ctx.fillRect(barX, top + 8, 60 * gain, 6);

    if (timeData) {
      ctx.strokeStyle = LAYER_COLORS[name];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const usableW = width - labelW - 12;
      const step = Math.floor(timeData.length / usableW) || 1;
      let drawn = 0;
      for (let i = 0; i < timeData.length && drawn < usableW; i += step, drawn++) {
        const x = labelW + drawn;
        const y = mid + timeData[i] * (stripH * 0.42);
        if (drawn === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });

  ctx.fillStyle = '#8a97a8';
  ctx.font = '11px monospace';
  const stats = engine?.getStats();
  if (stats) {
    ctx.fillText(
      `活动节点 ${stats.activeNodeCount} · 创建 ${stats.createdNodes} · 销毁 ${stats.disposedNodes} · 监听 ${stats.listenerCount}`,
      width - 360,
      12
    );
  }
}
