// Canvas 渲染: 井筒剖面 / 轿厢 / 人员设备 / 环境状态
(function (root) {
  'use strict';
  var MineSim = root.MineSim || require('./sim.js');

  var SHAFT_X = 150, SHAFT_W = 120, TOP = 40, BOTTOM = 600, MAXD = 600;

  function yOf(depth) { return TOP + (depth / MAXD) * (BOTTOM - TOP); }

  function tempColor(t) {
    if (t <= 30) return '#2e5a3c';
    if (t <= 35) return '#6a6a2e';
    if (t <= 40) return '#8a5a26';
    if (t <= 45) return '#a04a24';
    return '#b03030';
  }

  function draw(ctx, sim, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14181d';
    ctx.fillRect(0, 0, w, h);

    // 井段背景(按温度着色) + 通风标记
    sim.segments.forEach(function (seg) {
      var y1 = yOf(seg.from), y2 = yOf(seg.to);
      ctx.fillStyle = tempColor(seg.temp);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(SHAFT_X, y1, SHAFT_W, y2 - y1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#cfd8dc';
      ctx.font = '11px monospace';
      ctx.fillText(seg.temp.toFixed(1) + '℃', SHAFT_X + SHAFT_W + 8, (y1 + y2) / 2);
      ctx.fillStyle = seg.vent === 'good' ? '#6fcF6f' : '#e0a030';
      ctx.fillText(seg.vent === 'good' ? '通风✓' : '通风✗',
                   SHAFT_X + SHAFT_W + 8, (y1 + y2) / 2 + 13);
    });

    // 井筒边框与水平层线
    ctx.strokeStyle = '#8a929c';
    ctx.lineWidth = 2;
    ctx.strokeRect(SHAFT_X, TOP, SHAFT_W, BOTTOM - TOP);
    sim.cfg.levels.forEach(function (d, i) {
      var y = yOf(d);
      ctx.strokeStyle = '#4a525c';
      ctx.beginPath(); ctx.moveTo(SHAFT_X - 30, y); ctx.lineTo(SHAFT_X + SHAFT_W + 30, y); ctx.stroke();
      ctx.fillStyle = '#9fb3c8';
      ctx.fillText('L' + i + ' ' + d + 'm', SHAFT_X - 66, y + 4);
    });

    // 等待中的人员与设备
    sim.actors.forEach(function (a, idx) {
      if (a.level < 0 || a.rescued || a.delivered) return;
      var y = yOf(sim.cfg.levels[a.level]);
      var side = (idx % 2 === 0) ? -1 : 1;
      var x = SHAFT_X + (side < 0 ? -14 - 10 * (idx % 3) : SHAFT_W + 14 + 10 * (idx % 3));
      if (a.kind === 'worker') {
        var stress = a.heatStress / sim.cfg.heatStressLimit;
        ctx.fillStyle = stress > 0.6 ? '#e05050' : '#5aa7e0';
        ctx.beginPath(); ctx.arc(x, y - 6, 5, 0, 7); ctx.fill();
        ctx.fillStyle = '#cfd8dc';
        ctx.fillText(a.id, x - 8, y + 12);
      } else {
        ctx.fillStyle = '#c9a227';
        ctx.fillRect(x - 6, y - 12, 12, 12);
        ctx.fillStyle = '#cfd8dc';
        ctx.fillText(a.id, x - 8, y + 12);
      }
    });

    // 轿厢
    var cy = yOf(sim.cage.pos);
    ctx.fillStyle = sim.brakeFailed ? '#7a2a2a' : '#30414f';
    ctx.strokeStyle = '#9fb3c8';
    ctx.fillRect(SHAFT_X + 10, cy - 22, SHAFT_W - 20, 44);
    ctx.strokeRect(SHAFT_X + 10, cy - 22, SHAFT_W - 20, 44);
    // 缆绳
    ctx.strokeStyle = '#6a737c';
    ctx.beginPath(); ctx.moveTo(SHAFT_X + SHAFT_W / 2, TOP - 18);
    ctx.lineTo(SHAFT_X + SHAFT_W / 2, cy - 22); ctx.stroke();
    // 轿厢内载荷
    sim.cage.load.forEach(function (a, i) {
      var x = SHAFT_X + 24 + i * 18;
      if (a.kind === 'worker') {
        ctx.fillStyle = '#5aa7e0';
        ctx.beginPath(); ctx.arc(x, cy, 6, 0, 7); ctx.fill();
      } else {
        ctx.fillStyle = '#c9a227';
        ctx.fillRect(x - 6, cy - 6, 12, 12);
      }
    });
    ctx.fillStyle = '#9fb3c8';
    ctx.fillText('载重 ' + MineSim.loadWeight(sim) + '/' + sim.cfg.capacity + 'kg',
                 SHAFT_X + 6, cy + 34);
    if (sim.brakeFailed) {
      ctx.fillStyle = '#ff6060';
      ctx.fillText('!! 制动故障 检修中 ' + sim.repairRemaining, SHAFT_X - 40, cy - 28);
    }
  }

  root.MineRender = { draw: draw };
})(typeof self !== 'undefined' ? self : this);
