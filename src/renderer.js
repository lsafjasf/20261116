// Canvas 渲染：路网、车辆、拥堵热图、封路标记；支持导出 PNG dataURL

function heatColor(ratio) {
  const r = Math.min(1, ratio);
  const red = Math.round(255 * r);
  const green = Math.round(180 * (1 - r));
  return `rgb(${red},${green},60)`;
}

function drawArrow(ctx, x1, y1, x2, y2) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = 7;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - 0.45), y2 - size * Math.sin(angle - 0.45));
  ctx.lineTo(x2 - size * Math.cos(angle + 0.45), y2 - size * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
}

export function renderScene(canvas, view) {
  const { result, tick, heatmap, closures, selectedEdgeId, selectedVehicleId, filters } = view;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0f1620';
  ctx.fillRect(0, 0, w, h);

  const g = result.graph;
  const heatById = new Map(result.heatmap.map((x) => [x.id, x]));
  const snap = result.ticks[Math.min(tick, result.ticks.length - 1)];
  const closedNow = new Set(g.closures.filter((c) => tick >= c.from && tick <= c.to).map((c) => c.edgeId));

  // 道路
  for (const edge of g.edgeById.values()) {
    const a = g.nodeById.get(edge.from);
    const b = g.nodeById.get(edge.to);
    const isClosed = closedNow.has(edge.id);
    ctx.lineWidth = 3 + edge.lanes * 1.5;
    if (isClosed) {
      ctx.strokeStyle = '#ff4d4f';
      ctx.setLineDash([10, 8]);
    } else if (heatmap) {
      const ratio = heatById.get(edge.id)?.ratio || 0;
      ctx.strokeStyle = heatColor(ratio);
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = edge.id === selectedEdgeId ? '#ffd666' : '#5b6b80';
      ctx.setLineDash([]);
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (isClosed) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      ctx.fillStyle = '#ff4d4f';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText('封', mx - 6, my - 8);
    }
    if (edge.directed) {
      ctx.fillStyle = isClosed ? '#ff4d4f' : '#9fb4cc';
      drawArrow(ctx, a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  }

  // 节点
  for (const node of g.nodeById.values()) {
    ctx.beginPath();
    ctx.arc(node.x, node.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#d6e2f0';
    ctx.fill();
    ctx.strokeStyle = '#1c2735';
    ctx.stroke();
    ctx.fillStyle = '#c8d4e3';
    ctx.font = '12px sans-serif';
    ctx.fillText(node.id, node.x + 9, node.y - 9);
  }

  // 车辆
  const stateColor = {
    moving: '#52c41a', waiting: '#faad14', arrived: '#1890ff',
    unreachable: '#ff4d4f', pending: '#8c8c8c',
  };
  for (const pos of snap.positions) {
    const vehicle = result.vehicles.get(pos.id);
    if (filters.state && filters.state !== 'all' && vehicle.state !== filters.state) continue;
    const selected = pos.id === selectedVehicleId;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, selected ? 8 : 5, 0, Math.PI * 2);
    ctx.fillStyle = stateColor[vehicle.state] || '#fff';
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (selected) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(pos.id, pos.x + 10, pos.y + 4);
    }
  }

  // 图例
  ctx.font = '12px sans-serif';
  const legend = ['moving 行驶', 'waiting 等待', 'arrived 到达', 'unreachable 不可达'];
  const colors = ['#52c41a', '#faad14', '#1890ff', '#ff4d4f'];
  legend.forEach((text, i) => {
    ctx.fillStyle = colors[i];
    ctx.fillRect(12, h - 72 + i * 17, 10, 10);
    ctx.fillStyle = '#c8d4e3';
    ctx.fillText(text, 28, h - 63 + i * 17);
  });
}

export function exportPngDataUrl(canvas, view) {
  renderScene(canvas, view);
  return canvas.toDataURL('image/png');
}
