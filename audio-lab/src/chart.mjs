// Dependency-free line chart for node/connection/heap trends on a 2D canvas.

export function drawSeries(canvas, seriesList, options = {}) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = options.background || '#141830';
  ctx.fillRect(0, 0, width, height);

  const padding = 34;
  const allValues = seriesList.flatMap((entry) => entry.data);
  const maxValue = Math.max(1, ...allValues);
  const maxLength = Math.max(2, ...seriesList.map((entry) => entry.data.length));

  ctx.strokeStyle = '#2a3052';
  ctx.lineWidth = 1;
  for (let grid = 0; grid <= 4; grid += 1) {
    const y = padding + ((height - padding * 2) * grid) / 4;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
    ctx.fillStyle = '#9aa3c7';
    ctx.font = '10px sans-serif';
    ctx.fillText(String(Math.round(maxValue * (1 - grid / 4))), 4, y + 3);
  }

  for (const entry of seriesList) {
    const { data, color, label } = entry;
    if (data.length === 0) continue;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((value, index) => {
      const x = padding + ((width - padding * 2) * index) / Math.max(1, maxLength - 1);
      const y = height - padding - ((height - padding * 2) * value) / maxValue;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    data.forEach((value, index) => {
      const x = padding + ((width - padding * 2) * index) / Math.max(1, maxLength - 1);
      const y = height - padding - ((height - padding * 2) * value) / maxValue;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.font = '11px sans-serif';
    ctx.fillText(label, padding + seriesList.indexOf(entry) * 130, 16);
  }
}
