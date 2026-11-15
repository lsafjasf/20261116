import { fontString } from "./measure.js";

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawBackdrop(context, width, height, clock) {
  const base = context.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, "#111725");
  base.addColorStop(0.48, "#090c13");
  base.addColorStop(1, "#14100f");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);

  const glowX = width * (0.7 + Math.sin(clock * 0.11) * 0.025);
  const glow = context.createRadialGradient(glowX, height * 0.24, 0, glowX, height * 0.24, width * 0.55);
  glow.addColorStop(0, "rgba(244, 182, 98, 0.18)");
  glow.addColorStop(0.42, "rgba(190, 109, 59, 0.07)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  const cool = context.createRadialGradient(width * 0.2, height * 0.8, 0, width * 0.2, height * 0.8, width * 0.5);
  cool.addColorStop(0, "rgba(92, 160, 180, 0.09)");
  cool.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = cool;
  context.fillRect(0, 0, width, height);

  context.save();
  context.globalAlpha = 0.08;
  context.strokeStyle = "#d7e4e8";
  context.lineWidth = 1;
  const spacing = Math.max(48, width / 18);
  for (let x = -height; x < width; x += spacing) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + height * 0.55, height);
    context.stroke();
  }
  context.restore();

  context.strokeStyle = "rgba(255,255,255,0.07)";
  context.lineWidth = 1;
  context.strokeRect(22.5, 22.5, width - 45, height - 45);

  context.strokeStyle = "rgba(244, 182, 98, 0.56)";
  context.lineWidth = 1.5;
  const tick = 16;
  for (const [x, y, dx, dy] of [
    [22, 22, 1, 1],
    [width - 22, 22, -1, 1],
    [22, height - 22, 1, -1],
    [width - 22, height - 22, -1, -1]
  ]) {
    context.beginPath();
    context.moveTo(x, y + dy * tick);
    context.lineTo(x, y);
    context.lineTo(x + dx * tick, y);
    context.stroke();
  }
}

function drawSubtitle(context, layout, view, width, height) {
  const padX = 26;
  const padY = 19;
  const fit = Math.min(1, (width * 0.9) / (layout.width + padX * 2));
  const scale = fit * view.zoom;
  const panelWidth = (layout.width + padX * 2) * scale;
  const contentHeight = (layout.height + padY * 2) * scale;
  const viewportHeight = Math.min(contentHeight, Math.max(96, height * 0.44));
  const panelX = (width - panelWidth) / 2;
  const panelTop = height * 0.9 - viewportHeight;
  const maxScrollPx = Math.max(0, contentHeight - viewportHeight);
  const scrollPx = view.scroll * maxScrollPx;

  context.save();
  context.shadowColor = "rgba(0, 0, 0, 0.55)";
  context.shadowBlur = 32;
  context.shadowOffsetY = 14;
  const panelGradient = context.createLinearGradient(0, panelTop, 0, panelTop + viewportHeight);
  panelGradient.addColorStop(0, "rgba(18, 20, 25, 0.88)");
  panelGradient.addColorStop(1, "rgba(8, 10, 14, 0.92)");
  context.fillStyle = panelGradient;
  roundedRect(context, panelX, panelTop, panelWidth, viewportHeight, 18);
  context.fill();
  context.restore();

  context.save();
  context.strokeStyle = "rgba(255, 255, 255, 0.1)";
  context.lineWidth = 1;
  roundedRect(context, panelX + 0.5, panelTop + 0.5, panelWidth - 1, viewportHeight - 1, 18);
  context.stroke();
  roundedRect(context, panelX, panelTop, panelWidth, viewportHeight, 18);
  context.clip();

  context.translate(panelX + padX * scale, panelTop + padY * scale - scrollPx);
  context.scale(scale, scale);
  context.font = fontString(layout.style);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  for (const line of layout.lines) {
    const baseline = line.y + layout.style.fontSize * 0.82;
    context.fillStyle = "rgba(0, 0, 0, 0.58)";
    context.fillText(line.text, line.x + 1.2, baseline + 1.6);
    context.fillStyle = "#f7f2e8";
    context.fillText(line.text, line.x, baseline);
  }
  context.restore();

  if (maxScrollPx > 0.5) {
    const trackX = panelX + panelWidth - 7;
    const trackTop = panelTop + 12;
    const trackHeight = viewportHeight - 24;
    const thumbHeight = Math.max(16, (viewportHeight * viewportHeight) / contentHeight);
    const thumbTop = trackTop + (trackHeight - thumbHeight) * view.scroll;
    context.fillStyle = "rgba(255,255,255,0.09)";
    roundedRect(context, trackX, trackTop, 2.5, trackHeight, 2);
    context.fill();
    context.fillStyle = "rgba(244, 182, 98, 0.72)";
    roundedRect(context, trackX, thumbTop, 2.5, thumbHeight, 2);
    context.fill();
  }

  return {
    panelX,
    panelTop,
    panelWidth,
    panelHeight: viewportHeight,
    scale,
    contentHeight,
    maxScrollPx,
    scrollPx
  };
}

export function drawScene(canvas, layout, view) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  if (width < 2 || height < 2) return null;
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  drawBackdrop(context, width, height, view.clock || 0);
  return drawSubtitle(context, layout, view, width, height);
}
