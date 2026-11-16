import { WORLD, ANCHOR, ZONES } from '../engine/config.mjs';

export function createRenderer(ctx) {
  function draw(state, options = {}) {
    const { highlightConflict = null, frameLabel = '' } = options;
    drawBackground(ctx);
    drawZones(ctx, state);
    drawCracks(ctx, state);
    drawRails(ctx);
    drawRopes(ctx, state);
    drawAnchors(ctx);
    drawPlayers(ctx, state);
    drawCrate(ctx, state, highlightConflict);
    drawHud(ctx, state, frameLabel);
  }
  return { draw, width: WORLD.width, height: WORLD.height };
}

function drawBackground(ctx) {
  ctx.fillStyle = '#0b1f2e';
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);
  const grad = ctx.createLinearGradient(0, WORLD.lakeTop, 0, WORLD.lakeBottom);
  grad.addColorStop(0, '#173e55');
  grad.addColorStop(1, '#0f2c3f');
  ctx.fillStyle = grad;
  ctx.fillRect(WORLD.shoreWidth, WORLD.lakeTop, WORLD.width - WORLD.shoreWidth * 2, WORLD.lakeBottom - WORLD.lakeTop);
  ctx.fillStyle = '#3a4a3f';
  ctx.fillRect(0, 0, WORLD.shoreWidth, WORLD.height);
  ctx.fillRect(WORLD.width - WORLD.shoreWidth, 0, WORLD.shoreWidth, WORLD.height);
  ctx.fillStyle = 'rgba(120,220,170,0.18)';
  ctx.fillRect(WORLD.shoreWidth - 6, WORLD.lakeTop, WORLD.safeEdge - WORLD.shoreWidth + 6, WORLD.lakeBottom - WORLD.lakeTop);
  ctx.strokeStyle = 'rgba(140,240,190,0.7)';
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.moveTo(WORLD.safeEdge, WORLD.lakeTop);
  ctx.lineTo(WORLD.safeEdge, WORLD.lakeBottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#bfeedd';
  ctx.font = "18px 'Microsoft YaHei','SimHei',sans-serif";
  ctx.fillText('安全区', WORLD.shoreWidth + 12, WORLD.lakeTop + 26);
}

function drawZones(ctx, state) {
  for (const z of ZONES) {
    const live = state.zones.find((q) => q.id === z.id);
    if (z.weak) {
      ctx.fillStyle = 'rgba(120,180,220,0.10)';
      ctx.fillRect(z.x, z.y, z.w, z.h);
      ctx.strokeStyle = 'rgba(150,200,240,0.25)';
      ctx.strokeRect(z.x + 1, z.y + 1, z.w - 2, z.h - 2);
    }
    if (live && live.crackTick !== null) {
      const dmg = 1 - live.strength;
      ctx.fillStyle = `rgba(255,120,90,${0.08 + dmg * 0.22})`;
      ctx.fillRect(z.x, z.y, z.w, z.h);
    }
  }
}

function drawCracks(ctx, state) {
  ctx.lineCap = 'round';
  for (const crack of state.cracks) {
    const zone = ZONES.find((z) => z.id === crack.id);
    const live = state.zones.find((q) => q.id === crack.id);
    const alpha = 0.45 + (1 - (live ? live.strength : 0.5)) * 0.5;
    ctx.strokeStyle = `rgba(235,240,245,${Math.min(1, alpha)})`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const b of crack.branches) {
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,160,120,0.8)';
      ctx.font = "11px 'Microsoft YaHei','SimHei',monospace";
    ctx.fillText(crack.id, zone.x + 4, zone.y + 14);
  }
}

function drawRails(ctx) {
  for (const x of [ANCHOR.leftX, ANCHOR.rightX]) {
    ctx.strokeStyle = 'rgba(200,220,235,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, ANCHOR.railTop);
    ctx.lineTo(x, ANCHOR.railBottom);
    ctx.stroke();
  }
}

function drawRopes(ctx, state) {
  const crate = state.crate;
  const pairs = [
    ['left', state.players.left, '#8fd3ff'],
    ['right', state.players.right, '#ffd28f'],
  ];
  for (const [side, player, color] of pairs) {
    const rope = state.ropes[side];
    ctx.strokeStyle = rope.snapped ? 'rgba(160,160,160,0.5)' : color;
    ctx.lineWidth = rope.snapped ? 1.5 : 2.5;
    ctx.setLineDash(rope.snapped ? [6, 6] : []);
    ctx.beginPath();
    ctx.moveTo(player.x, player.y);
    if (rope.snapped) {
      const midX = (player.x + crate.x) / 2;
      const midY = (player.y + crate.y) / 2 + 24;
      ctx.lineTo(midX, midY);
    } else {
      ctx.lineTo(crate.x, crate.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawAnchors(ctx) {
  for (const x of [ANCHOR.leftX, ANCHOR.rightX]) {
    ctx.fillStyle = '#d8e4ee';
    for (const y of [ANCHOR.railTop, ANCHOR.railBottom]) {
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawPlayers(ctx, state) {
  drawPlayer(ctx, state.players.left, '#57b7ff', 'P1 卷索');
  drawPlayer(ctx, state.players.right, '#ffb85c', 'P2 导向');
}

function drawPlayer(ctx, player, color, label) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(player.x, player.y, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0b1f2e';
  ctx.lineWidth = 2;
  ctx.stroke();
  if (player.brace > 0.05) {
    ctx.strokeStyle = `rgba(255,90,90,${player.brace})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(player.x, player.y, 18, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#e8f1f8';
  ctx.font = "12px 'Microsoft YaHei','SimHei',sans-serif";
  ctx.fillText(label, player.x - 28, player.y - 22);
}

function drawCrate(ctx, state, highlight) {
  const { crate } = state;
  ctx.save();
  ctx.translate(crate.x, crate.y);
  ctx.rotate(crate.angle);
  ctx.fillStyle = highlight ? '#ff7a6b' : '#c98a4b';
  ctx.fillRect(-34, -34, 68, 68);
  ctx.strokeStyle = '#5d3a1e';
  ctx.lineWidth = 3;
  ctx.strokeRect(-34, -34, 68, 68);
  ctx.beginPath();
  ctx.moveTo(-34, -34);
  ctx.lineTo(34, 34);
  ctx.moveTo(34, -34);
  ctx.lineTo(-34, 34);
  ctx.strokeStyle = 'rgba(93,58,30,0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
  if (highlight) {
    ctx.strokeStyle = '#ff5a4d';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(crate.x, crate.y, 46, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawHud(ctx, state, frameLabel) {
  ctx.fillStyle = 'rgba(6,18,28,0.78)';
  ctx.fillRect(WORLD.shoreWidth, 12, WORLD.width - WORLD.shoreWidth * 2, 78);
  ctx.fillStyle = '#e8f1f8';
  ctx.font = "14px 'Microsoft YaHei','SimHei',monospace";
  const g = state.gauges;
  ctx.fillText(
    `tick ${state.tick}  t ${state.elapsed.toFixed(2)}s  进度 ${state.progress.toFixed(0)}%  冰面耐久 ${state.integrity.toFixed(1)}  张力 ${g.tension}  导向载荷 ${g.guideLoad}  应力 ${g.stress}  ${state.status}${state.endReason ? ':' + state.endReason : ''}`,
    WORLD.shoreWidth + 14,
    30,
  );
  drawBar(ctx, WORLD.shoreWidth + 14, 60, 200, 9, state.progress / 100, '#57d28a', '进度');
  drawBar(ctx, WORLD.shoreWidth + 280, 60, 200, 9, state.integrity / 100, '#7cc7ff', '耐久');
  drawBar(ctx, WORLD.shoreWidth + 546, 60, 200, 9, g.tension, '#ffb85c', '张力');
  if (frameLabel) {
    ctx.fillStyle = '#ffd28f';
    ctx.fillText(frameLabel, WORLD.width - WORLD.shoreWidth - 300, 30);
  }
}

function drawBar(ctx, x, y, w, h, value, color, label) {
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, value)), h);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#dfe9f2';
  ctx.font = "10px 'Microsoft YaHei','SimHei',sans-serif";
  ctx.fillText(label, x + w + 6, y + 8);
}
