const FONT_SANS = '"Noto Sans SC", sans-serif';
const FONT_MONO = '"IBM Plex Mono", monospace';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, t) => a + (b - a) * t;

function hexToRgb(hex) {
  const value = String(hex || "#FFFFFF").replace("#", "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  const number = Number.parseInt(full, 16);
  return { r: (number >> 16) & 255, g: (number >> 8) & 255, b: number & 255 };
}

function mixColor(from, to, amount) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return `rgb(${Math.round(lerp(a.r, b.r, amount))}, ${Math.round(lerp(a.g, b.g, amount))}, ${Math.round(lerp(a.b, b.b, amount))})`;
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function keyframeAt(keyframes, time) {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (!sorted.length) return { x: 76, y: 0, opacity: 1, color: "#D7FF45" };
  if (time <= sorted[0].time) return { ...sorted[0] };
  if (time >= sorted[sorted.length - 1].time) return { ...sorted[sorted.length - 1] };
  const rightIndex = sorted.findIndex((keyframe) => keyframe.time >= time);
  const right = sorted[rightIndex];
  const left = sorted[rightIndex - 1];
  const range = right.time - left.time || 1;
  const amount = clamp((time - left.time) / range, 0, 1);
  return {
    time,
    x: lerp(left.x, right.x, amount),
    y: lerp(left.y, right.y, amount),
    opacity: lerp(left.opacity, right.opacity, amount),
    color: mixColor(left.color, right.color, amount)
  };
}

function tokenize(text) {
  return Array.from(text);
}

function measureWrapped(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const token of tokenize(text)) {
    if (token === "\n") {
      lines.push(line.trimEnd());
      line = "";
      continue;
    }
    const candidate = line + token;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line.trimEnd());
      line = token.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

export function measureTitle(ctx, title, maxWidth = 775) {
  const length = Array.from(title).length;
  const start = length > 24 ? 60 : length > 16 ? 68 : 78;
  const maxLines = length > 24 ? 3 : length > 14 ? 2 : 1;
  let best = null;
  for (let size = start; size >= 36; size -= 2) {
    ctx.font = `700 ${size}px ${FONT_SANS}`;
    const lines = measureWrapped(ctx, title, maxWidth);
    const longest = Math.max(0, ...lines.map((line) => ctx.measureText(line).width));
    const lineHeight = Math.round(size * 1.16);
    const orphanPunctuation = lines.length > 1 && Array.from(lines.at(-1) || "").length <= 1;
    if (lines.length <= maxLines && longest <= maxWidth && !orphanPunctuation) {
      best = { fontSize: size, lines, lineHeight, width: longest, titleLength: length };
      break;
    }
  }
  if (!best) {
    ctx.font = `700 36px ${FONT_SANS}`;
    const lines = measureWrapped(ctx, title, maxWidth).slice(0, 3);
    best = { fontSize: 36, lines, lineHeight: 42, width: maxWidth, titleLength: length };
  }
  const textHeight = Math.max(best.lineHeight, best.lines.length * best.lineHeight);
  return { ...best, textHeight, titleBottom: 202 + textHeight };
}

function drawBackground(ctx, width, height, time, template, motion) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#151712");
  gradient.addColorStop(0.62, "#1d2018");
  gradient.addColorStop(1, "#10110e");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const pulse = 0.5 + Math.sin(time * 0.72) * 0.5;
  const orbitX = width * (0.73 + Math.sin(time * 0.31) * 0.06) + (motion.x - 76) * 2;
  const orbitY = height * (0.36 + Math.cos(time * 0.26) * 0.05);
  const radius = 250 + pulse * 35;
  const glow = ctx.createRadialGradient(orbitX, orbitY, 10, orbitX, orbitY, radius);
  glow.addColorStop(0, rgba(template.accent, 0.23));
  glow.addColorStop(0.6, rgba(motion.color, 0.08));
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(orbitX, orbitY);
  ctx.rotate(-0.18 + Math.sin(time * 0.17) * 0.08);
  ctx.strokeStyle = rgba(template.accent, 0.22);
  ctx.lineWidth = 1;
  for (let index = 0; index < 5; index += 1) {
    ctx.beginPath();
    ctx.ellipse(0, 0, 146 + index * 65, 104 + index * 44, index * 0.12, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = rgba(template.accent, 0.95);
  ctx.beginPath();
  ctx.arc(192, -42, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rgba("#FFFFFF", 0.82);
  ctx.beginPath();
  ctx.arc(-130, 78, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (template.transition === "sweep") {
    ctx.save();
    ctx.translate(width * 0.64 + (motion.x - 76) * 3, height * 0.45);
    ctx.rotate(-0.57);
    ctx.fillStyle = rgba(template.accent, 0.12);
    ctx.fillRect(-110, -340, 120 + pulse * 45, 680);
    ctx.fillStyle = rgba("#FF7048", 0.08);
    ctx.fillRect(58, -340, 30, 680);
    ctx.restore();
  }

  if (template.transition === "grid") {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.055)";
    ctx.lineWidth = 1;
    const offset = (time * 8) % 52;
    for (let x = -52 + offset; x < width; x += 52) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = -52 + offset; y < height; y += 52) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.075)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(width * 0.62, 0);
  ctx.lineTo(width * 0.62, height);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, height * 0.73);
  ctx.lineTo(width, height * 0.73);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.font = `700 420px ${FONT_MONO}`;
  ctx.fillStyle = "#FFFFFF";
  ctx.textAlign = "right";
  ctx.fillText("26", width - 38, 570);
  ctx.restore();

  const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, width * 0.72);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

function drawCard(ctx, card, x, y, width, height, index, time, accent, visible) {
  if (!visible) return;
  ctx.save();
  ctx.globalAlpha = visible;
  ctx.fillStyle = "rgba(255,255,255,0.045)";
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 3);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = rgba(accent, 0.92);
  ctx.fillRect(x, y, 34, 3);
  ctx.font = `500 10px ${FONT_MONO}`;
  ctx.fillStyle = "rgba(255,255,255,0.46)";
  ctx.fillText(`0${index + 1} / ${card.label}`, x + 14, y + 26);

  ctx.font = `700 30px ${FONT_SANS}`;
  ctx.fillStyle = "#F4F2EA";
  ctx.fillText(card.value, x + 14, y + 69);

  ctx.font = `400 9px ${FONT_MONO}`;
  ctx.fillStyle = "rgba(255,255,255,0.42)";
  ctx.fillText(card.note, x + 14, y + 90);

  const meterWidth = width - 28;
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(x + 14, y + height - 23, meterWidth, 2);
  const fill = [0.68, 0.48, 0.82, 0.58][index % 4] * clamp(time / 2.5, 0, 1);
  ctx.fillStyle = rgba(accent, 0.85);
  ctx.fillRect(x + 14, y + height - 23, meterWidth * fill, 2);
  ctx.restore();
}

export function renderStage(canvas, state) {
  const { template, instance, result, cards, time } = state;
  const ctx = canvas.getContext("2d", { alpha: false });
  const width = canvas.width;
  const height = canvas.height;
  const motion = keyframeAt(template.keyframes, time);
  const contentX = 76 + (motion.x - 76);
  const titleWidth = width - contentX - 150;

  drawBackground(ctx, width, height, time, template, motion);

  ctx.save();
  ctx.globalAlpha = motion.opacity;
  ctx.translate(0, motion.y);

  ctx.font = `500 10px ${FONT_MONO}`;
  ctx.fillStyle = rgba(motion.color, 0.9);
  ctx.fillText(instance.kicker, contentX, 73);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(contentX + 164, 69, 145, 1);
  ctx.font = `400 8px ${FONT_MONO}`;
  ctx.fillStyle = "rgba(255,255,255,0.44)";
  ctx.fillText("VOL. 04 / LIVE DATA", contentX + 322, 72);

  const layout = measureTitle(ctx, instance.title, titleWidth);
  ctx.font = `700 ${layout.fontSize}px ${FONT_SANS}`;
  ctx.fillStyle = "#F4F1E8";
  ctx.textBaseline = "top";
  layout.lines.forEach((line, index) => {
    ctx.fillText(line, contentX, 118 + index * layout.lineHeight);
  });
  ctx.textBaseline = "alphabetic";
  const underlineY = 118 + layout.lines.length * layout.lineHeight + 10;
  ctx.fillStyle = rgba(motion.color, 0.92);
  ctx.fillRect(contentX, underlineY, 58, 3);

  const cardTop = clamp(underlineY + 30, 320, 485);
  const gap = template.cardGap;
  const cardWidth = (width - contentX - 76 - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 130;
  cards.forEach((card, index) => {
    const entrance = clamp((time - 0.7 - index * 0.18) / 0.55, 0, 1);
    const eased = 1 - (1 - entrance) ** 3;
    drawCard(
      ctx,
      card,
      contentX + index * (cardWidth + gap),
      cardTop + (1 - eased) * 22,
      cardWidth,
      cardHeight,
      index,
      time,
      motion.color,
      eased * motion.opacity
    );
  });
  ctx.restore();

  ctx.save();
  ctx.font = `400 8px ${FONT_MONO}`;
  ctx.fillStyle = "rgba(255,255,255,0.44)";
  ctx.fillText(`FILTER / ${result.filterLabel}`, 76, height - 58);
  ctx.fillText(`DATA / ${result.version}`, 76, height - 42);
  ctx.fillText(`SCOPE / ${result.acceptedCount} OF ${result.rawCount} RECORDS`, 76, height - 26);
  ctx.textAlign = "right";
  ctx.fillStyle = rgba(motion.color, 0.8);
  ctx.fillText("ATLAS / 2026", width - 76, height - 42);
  ctx.fillStyle = "rgba(255,255,255,0.44)";
  ctx.fillText("12.00 SEC / 30 FPS", width - 76, height - 26);
  ctx.restore();

  const tickCount = 48;
  for (let index = 0; index < tickCount; index += 1) {
    const x = 76 + ((width - 152) / tickCount) * index;
    const active = index / tickCount <= time / 12;
    ctx.fillStyle = active ? rgba(motion.color, 0.76) : "rgba(255,255,255,0.1)";
    ctx.fillRect(x, height - 13, 1, active ? 4 : 2);
  }

  return {
    ...layout,
    cardTop,
    cardHeight,
    cardWidth,
    motion,
    time,
    signature: `${result.version}|${cards.map((card) => card.value).join("|")}|${layout.fontSize}|${layout.lines.length}|${instance.id}|${time.toFixed(3)}`
  };
}

export function renderStaticPreview(canvas, state) {
  return renderStage(canvas, { ...state, time: 6 });
}
