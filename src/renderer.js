/* Canvas-only instrumentation: binaural SPL meters, spectrum, diagnostic cards. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  root.AudioDiag = root.AudioDiag || {};
  root.AudioDiag.Renderer = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  Renderer.prototype.draw = function (engine) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '13px ui-monospace, monospace';
    ctx.textBaseline = 'middle';

    this._drawSpectrum(ctx, engine, 16, 14, 300, 150);
    this._drawSpl(ctx, engine, 340, 14, w - 360, 150);
    this._drawCards(ctx, engine, 16, 184, w - 32, h - 200);
  };

  Renderer.prototype._drawSpectrum = function (ctx, engine, x, y, w, h) {
    panel(ctx, x, y, w, h, '频谱 SPECTRUM (Hz)');
    const spec = engine.metrics.spectrum;
    const barW = (w - 40) / spec.length - 12;
    spec.forEach((s, i) => {
      const bx = x + 24 + i * (barW + 12);
      const levelH = (h - 56) * s.level / 100;
      const noiseH = (h - 56) * s.noise / 100;
      ctx.fillStyle = 'rgba(255,120,80,0.55)';
      ctx.fillRect(bx, y + h - 24 - noiseH, barW, noiseH);
      ctx.fillStyle = s.level > 88 ? '#f85149' : '#58a6ff';
      ctx.fillRect(bx, y + h - 24 - levelH, barW, levelH);
      ctx.fillStyle = '#c9d1d9';
      ctx.textAlign = 'center';
      ctx.fillText(String(s.fc), bx + barW / 2, y + h - 10);
    });
    if (engine.clipped) {
      ctx.fillStyle = '#f85149';
      ctx.textAlign = 'left';
      ctx.fillText('⚠ 削波 CLIP：噪声底抬升', x + 16, y + 18);
    }
  };

  Renderer.prototype._drawSpl = function (ctx, engine, x, y, w, h) {
    panel(ctx, x, y, w, h, '双耳声压 BINAURAL SPL (dB)');
    const rowH = (h - 36) / engine.devices.length;
    engine.metrics.spl.forEach((s, i) => {
      const ry = y + 26 + i * rowH;
      const device = engine.devices[i];
      ctx.fillStyle = '#8b949e';
      ctx.textAlign = 'left';
      ctx.fillText(device.name, x + 12, ry + rowH * 0.32);
      meter(ctx, x + 52, ry, (w - 76) / 2 - 8, 10, s.l / 120, '#58a6ff', 'L');
      meter(ctx, x + 52 + (w - 76) / 2 + 8, ry, (w - 76) / 2 - 8, 10, s.r / 120, '#bc8cff', 'R');
    });
  };

  Renderer.prototype._drawCards = function (ctx, engine, x, y, w, h) {
    panel(ctx, x, y, w, h, '诊断卡 DIAGNOSTIC CARDS');
    const cardW = (w - 16 * (engine.devices.length + 1)) / engine.devices.length;
    const label = engine.constructor.STATE_LABEL;
    engine.devices.forEach((d, i) => {
      const cx = x + 16 + i * (cardW + 16);
      const cy = y + 28;
      const ch = h - 44;
      const detail = engine.metrics.detail[i];
      const reject = engine.lastRejection && engine.lastRejection.deviceId === d.id;
      ctx.strokeStyle = d.solved ? '#3fb950' : reject ? '#f85149' : '#30363d';
      ctx.lineWidth = 2;
      ctx.fillStyle = '#161b22';
      roundRect(ctx, cx, cy, cardW, ch, 10);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e6edf3';
      ctx.textAlign = 'left';
      ctx.fillText(d.name + '  设备', cx + 12, cy + 18);
      ctx.fillStyle = d.solved ? '#3fb950' : '#8b949e';
      ctx.fillText(d.solved ? '已结案: ' + label[d.state] : '未诊断', cx + 12, cy + 38);
      ctx.fillStyle = '#c9d1d9';
      ctx.fillText('距离 ' + detail.dist.toFixed(2), cx + 12, cy + 60);
      ctx.fillText('清晰度 ' + (detail.clarity * 100).toFixed(0) + '%', cx + 12, cy + 80);
      ctx.fillText('SNR ' + detail.snr.toFixed(1) + 'dB', cx + 12, cy + 100);
      meter(ctx, cx + 12, cy + ch - 26, cardW - 24, 8, detail.clarity,
        detail.clarity >= 0.5 ? '#3fb950' : '#d29922', '');
      if (reject) {
        ctx.fillStyle = '#f85149';
        ctx.fillText('✕ ' + engine.lastRejection.reasons.join(','), cx + 12, cy + ch - 40);
      }
    });
  };

  function panel(ctx, x, y, w, h, title) {
    ctx.strokeStyle = '#30363d';
    ctx.fillStyle = '#161b22';
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#8b949e';
    ctx.textAlign = 'left';
    ctx.fillText(title, x + 12, y + 14);
  }

  function meter(ctx, x, y, w, h, ratio, color, tag) {
    ctx.fillStyle = '#21262d';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, ratio)), h);
    if (tag) {
      ctx.fillStyle = '#8b949e';
      ctx.textAlign = 'right';
      ctx.fillText(tag, x - 6, y + h / 2);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  return Renderer;
});
