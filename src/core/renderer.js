import { interpolateLayer, mixColor } from "./project.js";

export const CROP_ASPECTS = ["16:9", "9:16", "1:1"];

export function parseAspect(aspect) {
  const [width, height] = aspect.split(":").map(Number);
  if (!width || !height) throw new RangeError(`invalid crop aspect: ${aspect}`);
  return width / height;
}

export function getOutputDimensions(aspect = "16:9") {
  const ratio = parseAspect(aspect);
  if (aspect === "9:16") return { width: 540, height: 960 };
  if (aspect === "1:1") return { width: 720, height: 720 };
  return { width: 960, height: Math.round(960 / ratio) };
}

export function getThumbnailDimensions(aspect = "16:9") {
  if (aspect === "9:16") return { width: 108, height: 192 };
  if (aspect === "1:1") return { width: 144, height: 144 };
  return { width: 192, height: 108 };
}

export function getThumbnailCssSize(aspect = "16:9") {
  if (aspect === "9:16") return { width: 84, height: 149 };
  if (aspect === "1:1") return { width: 112, height: 112 };
  return { width: 136, height: 77 };
}

export function getCropRect(project, aspect) {
  const ratio = parseAspect(aspect);
  const sourceAspect = project.canvas.width / project.canvas.height;
  let width;
  let height;
  if (ratio <= sourceAspect) {
    height = project.canvas.height;
    width = height * ratio;
  } else {
    width = project.canvas.width;
    height = width / ratio;
  }
  return {
    x: (project.canvas.width - width) / 2,
    y: (project.canvas.height - height) / 2,
    width,
    height,
  };
}

export function renderProjectFrame(ctx, project, timeMs, options = {}) {
  const {
    width = project.canvas.width,
    height = project.canvas.height,
    cropAspect = "16:9",
    overlay = true,
  } = options;
  if (!ctx) throw new TypeError("canvas context is required");
  const crop = getCropRect(project, cropAspect);
  const now = Math.min(project.durationMs, Math.max(0, timeMs));

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#02050a";
  ctx.fillRect(0, 0, width, height);
  ctx.scale(width / crop.width, height / crop.height);
  ctx.translate(-crop.x, -crop.y);
  ctx.fillStyle = project.canvas.background;
  ctx.fillRect(0, 0, project.canvas.width, project.canvas.height);
  drawBackdrop(ctx, project, now);

  for (const layer of project.layers) {
    if (!layer.visible) continue;
    drawLayer(ctx, layer, now, project);
  }
  ctx.restore();

  if (overlay) drawOverlay(ctx, width, height, now, cropAspect);
}

function drawBackdrop(ctx, project, timeMs) {
  const gradient = ctx.createLinearGradient(0, 0, project.canvas.width, project.canvas.height);
  gradient.addColorStop(0, mixColor("#07101f", "#112f45", timeMs / project.durationMs));
  gradient.addColorStop(0.55, "#07101f");
  gradient.addColorStop(1, "#040914");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, project.canvas.width, project.canvas.height);

  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = "#4f7c94";
  ctx.lineWidth = 1;
  const grid = 60;
  for (let x = 0; x <= project.canvas.width; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, project.canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= project.canvas.height; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(project.canvas.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLayer(ctx, layer, timeMs, project) {
  const state = interpolateLayer(layer, timeMs);
  const centerX = state.x + state.width / 2;
  const centerY = state.y + state.height / 2;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, state.opacity));
  ctx.translate(centerX, centerY);
  ctx.rotate((state.rotation * Math.PI) / 180);
  ctx.translate(-state.width / 2, -state.height / 2);
  ctx.fillStyle = state.color;
  ctx.strokeStyle = state.color;
  ctx.shadowColor = state.color;
  ctx.shadowBlur = layer.shape === "ring" ? 26 : 18;

  if (layer.shape === "rect") {
    roundRect(ctx, 0, 0, state.width, state.height, 24);
    ctx.fill();
    ctx.globalAlpha *= 0.34;
    ctx.strokeStyle = "#8bd9d2";
    ctx.lineWidth = 3;
    ctx.stroke();
  } else if (layer.shape === "ring") {
    ctx.globalAlpha *= 0.92;
    ctx.lineWidth = Math.max(8, state.width * 0.045);
    ctx.beginPath();
    ctx.ellipse(state.width / 2, state.height / 2, state.width / 2, state.height / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha *= 0.38;
    ctx.lineWidth = Math.max(2, state.width * 0.012);
    ctx.beginPath();
    ctx.ellipse(state.width / 2, state.height / 2, state.width * 0.68, state.height * 0.68, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (layer.shape === "ellipse") {
    const gradient = ctx.createRadialGradient(
      state.width * 0.35,
      state.height * 0.3,
      2,
      state.width / 2,
      state.height / 2,
      state.width * 0.62,
    );
    gradient.addColorStop(0, "#fff3c4");
    gradient.addColorStop(0.24, state.color);
    gradient.addColorStop(1, mixColor(state.color, "#07101f", 0.64));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(state.width / 2, state.height / 2, state.width / 2, state.height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (layer.shape === "caption") {
    ctx.shadowBlur = 0;
    ctx.globalAlpha = Math.max(0.55, state.opacity);
    ctx.fillStyle = "rgba(3, 9, 18, 0.62)";
    roundRect(ctx, 0, 0, state.width, state.height, 12);
    ctx.fill();
    ctx.fillStyle = state.color;
    ctx.font = '700 22px "Noto Sans SC", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = "middle";
    ctx.fillText(layer.name, 20, state.height / 2);
  }
  ctx.restore();
}

function drawOverlay(ctx, width, height, timeMs, cropAspect) {
  const compact = width < 300 || height < 200;
  ctx.save();
  const pillWidth = compact ? Math.min(width - 12, 106) : 176;
  const pillHeight = compact ? 23 : 32;
  ctx.fillStyle = "rgba(2, 8, 18, 0.76)";
  roundRect(ctx, 10, 10, pillWidth, pillHeight, 7);
  ctx.fill();
  ctx.strokeStyle = "rgba(102, 232, 205, 0.46)";
  ctx.lineWidth = 1;
  roundRect(ctx, 10.5, 10.5, pillWidth - 1, pillHeight - 1, 7);
  ctx.stroke();
  ctx.fillStyle = "#8ff5dc";
  ctx.font = `${compact ? 600 : 700} ${compact ? 10 : 13}px "Noto Sans SC", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = "middle";
  const timecode = formatTimecode(timeMs);
  ctx.fillText(compact ? timecode : `${timecode}  ·  ${cropAspect}`, 20, 10 + pillHeight / 2);
  if (!compact) {
    ctx.fillStyle = "rgba(143, 245, 220, 0.74)";
    ctx.font = '700 11px "Noto Sans SC", "Segoe UI", sans-serif';
    ctx.textAlign = "right";
    ctx.fillText("FRAME LOCK", width - 18, 26);
  }
  ctx.restore();
}

export function formatTimecode(timeMs) {
  const safe = Math.max(0, Math.round(timeMs));
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = safe % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function roundRect(ctx, x, y, width, height, radius) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
}
