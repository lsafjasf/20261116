/* Canvas 渲染：所有画面数据来自同一 sim 快照，不产生任何状态。 */
(function () {
  'use strict';
  var E = window.BridgeEngine;
  var PAD_L = 60, PAD_R = 40, TOP = 60, BASE_Y = 250;

  function stressColor(r) {
    if (r >= 1) return '#ef5350';
    if (r >= 0.75) return '#ffa726';
    if (r >= 0.45) return '#ffd54f';
    return '#3a7bd5';
  }

  function xOf(xWorld, w) {
    return PAD_L + (xWorld / E.DECK_LEN) * (w - PAD_L - PAD_R);
  }

  function draw(ctx, sim, w, h) {
    ctx.clearRect(0, 0, w, h);
    var riverTop = BASE_Y + 70;
    ctx.fillStyle = '#0d1a2b';
    ctx.fillRect(0, 0, w, riverTop);

    var waterH = Math.max(0, (sim.water - 10) * 9);
    var wy = riverTop + 90 - waterH;
    var grad = ctx.createLinearGradient(0, wy, 0, h);
    grad.addColorStop(0, 'rgba(41,182,246,0.75)');
    grad.addColorStop(1, 'rgba(21,101,192,0.85)');
    ctx.fillStyle = grad;
    ctx.fillRect(PAD_L - 20, wy, w - PAD_L - PAD_R + 40, h - wy);
    ctx.strokeStyle = 'rgba(128,216,255,0.9)';
    ctx.beginPath();
    for (var wx = PAD_L - 20; wx < w - PAD_R + 20; wx += 8) {
      ctx.moveTo(wx, wy);
      ctx.lineTo(wx + 4, wy - 3);
    }
    ctx.stroke();
    ctx.fillStyle = '#9ad4ff';
    ctx.font = '12px monospace';
    ctx.fillText('水位 ' + sim.water.toFixed(1) + 'm', PAD_L, wy - 8);

    var def = sim.ratio.map(function (r, i) {
      if (sim.failed.indexOf(i) >= 0) return 26;
      return Math.min(20, r * r * 22);
    });

    sim.supports.filter(function (s) { return s.kind === 'cable'; }).forEach(function (c) {
      var cx = xOf(E.nodeX(c.node), w), topY = TOP;
      ctx.strokeStyle = sim.faults['cable:' + c.node] ? '#ef5350' : '#90caf9';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, topY);
      ctx.lineTo(cx, BASE_Y + def[c.node]);
      ctx.stroke();
    });

    ctx.lineWidth = 4;
    for (var seg = 0; seg < E.NODE_COUNT - 1; seg++) {
      var x1 = xOf(E.nodeX(seg), w), x2 = xOf(E.nodeX(seg + 1), w);
      var y1 = BASE_Y + def[seg], y2 = BASE_Y + def[seg + 1];
      var pr = Math.max(sim.ratio[seg], sim.ratio[seg + 1]);
      ctx.strokeStyle = stressColor(pr);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    for (var i = 0; i < E.NODE_COUNT; i++) {
      var nx = xOf(E.nodeX(i), w), ny = BASE_Y + def[i];
      ctx.fillStyle = stressColor(sim.ratio[i]);
      ctx.beginPath();
      ctx.arc(nx, ny, 6, 0, Math.PI * 2);
      ctx.fill();
      if (sim.reinforced.indexOf(i) >= 0) {
        ctx.strokeStyle = '#ffd54f';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(nx, ny, 10, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#8aa0ba';
      ctx.font = '10px monospace';
      ctx.fillText('N' + i, nx - 8, ny + 20);
      ctx.fillStyle = stressColor(sim.ratio[i]);
      ctx.fillText(sim.ratio[i].toFixed(2), nx - 12, ny - 12);
    }

    sim.supports.filter(function (s) { return s.kind === 'pier' || s.kind === 'abutment'; })
      .forEach(function (s) {
        var px = xOf(E.nodeX(s.node), w);
        var ground = s.kind === 'pier' && s.river ? h - 10 : BASE_Y + 60;
        var topY = BASE_Y + (def[s.node] || 0);
        var isFault = Object.keys(sim.faults).some(function (k) {
          var f = sim.faults[k];
          return f.target === s.id && f.repairedAt == null &&
            (f.until == null || sim.t < f.until);
        });
        ctx.fillStyle = s.kind === 'abutment' ? '#5b6b80' :
          (isFault ? '#ef5350' : '#7d8fa5');
        ctx.fillRect(px - 9, topY, 18, ground - topY);
        if (s.kind === 'pier') {
          ctx.fillStyle = '#dce6f2';
          ctx.font = '11px monospace';
          ctx.fillText(s.id + (s.river ? ' H=' + s.health.toFixed(2) : ''),
            px - 16, ground + 12);
        }
      });

    sim.trains.forEach(function (tr) {
      var rear = tr.front - tr.length;
      if (tr.front < -2 || rear > E.DECK_LEN + 2) return;
      var tx = xOf(rear, w), tw = (tr.length / E.DECK_LEN) *
        (w - PAD_L - PAD_R);
      var colors = { light: '#81c784', medium: '#ffb74d', heavy: '#e57373' };
      ctx.fillStyle = colors[tr.type];
      ctx.fillRect(tx, BASE_Y - 34, Math.max(6, tw), 20);
      ctx.fillStyle = '#0e1622';
      for (var a = 0; a < tr.axles; a++) {
        var ax = xOf(tr.front - a * tr.carLen, w);
        if (ax < PAD_L || ax > w - PAD_R) continue;
        ctx.beginPath();
        ctx.arc(ax, BASE_Y - 10, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#dce6f2';
      ctx.font = '11px monospace';
      ctx.fillText(E.TRAIN_TYPES[tr.type].name, tx + 4, BASE_Y - 40);
    });

    if (sim.status === 'failed') {
      ctx.fillStyle = 'rgba(239,83,80,0.12)';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff9a97';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText('连锁失稳 @t=' + sim.failTime.toFixed(1) + 's', w / 2 - 130, 40);
    }
  }

  window.BridgeRenderer = { draw: draw };
})();
