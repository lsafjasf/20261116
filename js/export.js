import {
  formatCompact,
  formatNumber,
  formatPct,
  formatSpeed,
  getDistrict
} from "./core.js";
import { chapterById } from "./views.js";

const COLORS = {
  paper: "#f3efe5",
  paperBright: "#fbf8f1",
  paperDeep: "#e7dfd0",
  ink: "#19211c",
  inkSoft: "#39413a",
  muted: "#71776e",
  line: "#c8c0b1",
  accent: "#e25738",
  teal: "#11766f",
  blue: "#2d6d96",
  gold: "#c4952f",
  dark: "#101713"
};

const FONT = '"Local Noto Sans SC", "Noto Sans SC", "PingFang SC", sans-serif';

function font(weight, size) {
  return `${weight} ${size}px ${FONT}`;
}

function line(ctx, x1, y1, x2, y2, color, width = 1) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function wrappedLines(ctx, text, maxWidth) {
  const rows = [];
  let current = "";
  for (const character of String(text)) {
    const next = current + character;
    if (current && ctx.measureText(next).width > maxWidth) {
      rows.push(current);
      current = character;
    } else {
      current = next;
    }
  }
  if (current) rows.push(current);
  return rows;
}

function drawWrapped(ctx, text, x, y, maxWidth, lineHeight, maxLines = 6) {
  const rows = wrappedLines(ctx, text, maxWidth).slice(0, maxLines);
  rows.forEach((row, index) => ctx.fillText(row, x, y + index * lineHeight));
  return y + rows.length * lineHeight;
}

function speedColor(speed) {
  if (!Number.isFinite(speed)) return COLORS.muted;
  if (speed < 16) return "#dc5538";
  if (speed < 23) return COLORS.gold;
  if (speed < 31) return COLORS.teal;
  return COLORS.blue;
}

function drawHeader(ctx, dataset, manifest, chapter) {
  ctx.fillStyle = COLORS.dark;
  ctx.fillRect(0, 0, 1600, 118);

  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(58, 33, 7, 26);
  ctx.fillRect(69, 21, 7, 50);
  ctx.fillRect(80, 39, 7, 32);

  ctx.fillStyle = COLORS.paperBright;
  ctx.font = font(800, 27);
  ctx.fillText("城市脉冲", 106, 49);
  ctx.fillStyle = "#9caaa0";
  ctx.font = font(500, 11);
  ctx.fillText("CITY PULSE / LINJIANG", 106, 69);

  ctx.fillStyle = COLORS.paperBright;
  ctx.font = font(700, 19);
  ctx.textAlign = "right";
  ctx.fillText(`${chapter.number} / ${chapter.kicker} · ${chapter.title}`, 1538, 47);
  ctx.fillStyle = "#9caaa0";
  ctx.font = font(500, 11);
  ctx.fillText(`${dataset.version} · ${dataset.city} · 当前章节导出`, 1538, 69);
  ctx.textAlign = "left";
}

function drawPageBackground(ctx) {
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, 1600, 1000);
  for (let x = 0; x < 1600; x += 80) {
    line(ctx, x, 118, x, 930, "rgba(25,33,28,0.035)", 1);
  }
  const gradient = ctx.createRadialGradient(1390, 180, 10, 1390, 180, 430);
  gradient.addColorStop(0, "rgba(226,87,56,0.10)");
  gradient.addColorStop(1, "rgba(226,87,56,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(900, 100, 700, 600);
}

function drawMap(ctx, dataset, view, chapterId, filters, rect) {
  const scale = Math.min(rect.width / 600, rect.height / 480);
  const offsetX = rect.x + (rect.width - 600 * scale) / 2;
  const offsetY = rect.y + (rect.height - 480 * scale) / 2;
  const selected = new Map(view.corridors.map((corridor) => [corridor.id, corridor]));
  const maxFlow = Math.max(1, ...view.corridors.map((corridor) => corridor.flow));

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  ctx.fillStyle = "#e9e5da";
  ctx.fillRect(0, 0, 600, 480);
  for (let x = 40; x < 600; x += 62) line(ctx, x, 0, x, 480, "rgba(25,33,28,0.06)", 1);
  for (let y = 40; y < 480; y += 58) line(ctx, 0, y, 600, y, "rgba(25,33,28,0.06)", 1);

  ctx.beginPath();
  ctx.moveTo(-20, 306);
  ctx.bezierCurveTo(88, 260, 148, 344, 238, 322);
  ctx.bezierCurveTo(310, 292, 384, 260, 470, 298);
  ctx.bezierCurveTo(520, 325, 560, 350, 622, 324);
  ctx.strokeStyle = "rgba(45,109,150,0.20)";
  ctx.lineWidth = 27;
  ctx.stroke();
  ctx.strokeStyle = "rgba(251,248,241,0.7)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 7]);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const district of dataset.districts) {
    const districtData = view.districts.find((item) => item.id === district.id);
    const muted = filters.districtId !== "all" && filters.districtId !== district.id;
    const radius = chapterId === "transit" && districtData
      ? 16 + (districtData.transitShare ?? 0.2) * 55
      : 31;
    ctx.globalAlpha = muted ? 0.25 : 1;
    ctx.fillStyle = district.tone;
    ctx.globalAlpha = muted ? 0.06 : 0.1;
    ctx.beginPath();
    ctx.arc(district.center[0], district.center[1], radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = muted ? 0.25 : 1;
    ctx.fillStyle = district.tone;
    ctx.beginPath();
    ctx.arc(district.center[0], district.center[1], 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.inkSoft;
    ctx.font = font(700, 10);
    ctx.fillText(district.name, district.center[0] + 10, district.center[1] - 9);
  }
  ctx.globalAlpha = 1;

  for (const corridor of dataset.corridors) {
    const metric = selected.get(corridor.id);
    const muted = !metric || (filters.districtId !== "all" && filters.districtId !== corridor.districtId);
    const ratio = metric ? Math.min(1, metric.flow / maxFlow) : 0;
    const width = chapterId === "speed" ? 7 : 3.5 + ratio * 10;
    const color = chapterId === "speed"
      ? speedColor(metric?.avgSpeed)
      : getDistrict(dataset, corridor.districtId)?.tone ?? COLORS.accent;
    ctx.globalAlpha = muted ? 0.17 : 0.94;
    ctx.beginPath();
    corridor.path.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point[0], point[1]);
      else ctx.lineTo(point[0], point[1]);
    });
    ctx.strokeStyle = COLORS.paperBright;
    ctx.lineWidth = width + 3.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
}

function drawFlowChart(ctx, view, rect) {
  if (!view.hours.length) return;
  const top = rect.y + 16;
  const bottom = rect.y + rect.height - 38;
  const left = rect.x + 54;
  const right = rect.x + rect.width - 22;
  const width = right - left;
  const height = bottom - top;
  const maxValue = Math.max(1, ...view.hours.map((hour) => hour.inbound + hour.outbound));
  const slot = width / view.hours.length;
  const barWidth = Math.min(50, slot * 0.52);

  for (let index = 0; index <= 3; index += 1) {
    const ratio = index / 3;
    const y = bottom - height * ratio;
    line(ctx, left, y, right, y, "rgba(25,33,28,0.12)", 1);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(400, 11);
    ctx.textAlign = "right";
    ctx.fillText(formatCompact(maxValue * ratio), left - 8, y + 4);
  }
  line(ctx, left, bottom, right, bottom, COLORS.ink, 1);
  ctx.textAlign = "center";
  view.hours.forEach((hour, index) => {
    const centerX = left + slot * index + slot / 2;
    const inboundHeight = (hour.inbound / maxValue) * height;
    const outboundHeight = (hour.outbound / maxValue) * height;
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(centerX - barWidth / 2, bottom - inboundHeight, barWidth, inboundHeight);
    ctx.fillStyle = COLORS.inkSoft;
    ctx.fillRect(centerX - barWidth / 2, bottom - inboundHeight - outboundHeight, barWidth, outboundHeight);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(400, 11);
    ctx.fillText(String(hour.hour).padStart(2, "0"), centerX, bottom + 17);
  });
  ctx.textAlign = "left";
}

function drawSpeedChart(ctx, view, rect) {
  const corridors = [...view.corridors].sort((left, right) => (left.avgSpeed ?? 0) - (right.avgSpeed ?? 0));
  if (!corridors.length) return;
  const top = rect.y + 12;
  const bottom = rect.y + rect.height - 20;
  const left = rect.x + 136;
  const right = rect.x + rect.width - 78;
  const width = right - left;
  const height = bottom - top;
  const maxSpeed = Math.max(40, Math.ceil(Math.max(...corridors.map((item) => item.avgSpeed ?? 0)) / 10) * 10);
  const step = height / corridors.length;

  for (let tick = 0; tick <= maxSpeed; tick += 10) {
    const x = left + (tick / maxSpeed) * width;
    line(ctx, x, top - 4, x, bottom, "rgba(25,33,28,0.12)", 1);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(400, 10);
    ctx.textAlign = "center";
    ctx.fillText(String(tick), x, bottom + 16);
  }
  corridors.forEach((corridor, index) => {
    const y = top + step * index + step / 2;
    const speed = corridor.avgSpeed ?? 0;
    const x = left + (speed / maxSpeed) * width;
    ctx.strokeStyle = "#d9d3c7";
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    ctx.strokeStyle = speedColor(speed);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.paperBright;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = speedColor(speed);
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = COLORS.inkSoft;
    ctx.font = font(700, 11);
    ctx.textAlign = "right";
    ctx.fillText(corridor.name, left - 10, y + 4);
    ctx.fillStyle = COLORS.ink;
    ctx.font = font(500, 10);
    ctx.textAlign = "left";
    ctx.fillText(formatSpeed(speed), x + 9, y + 4);
  });
  ctx.textAlign = "left";
}

function drawTransitChart(ctx, view, rect) {
  if (!view.districts.length) return;
  const top = rect.y + 18;
  const bottom = rect.y + rect.height - 42;
  const left = rect.x + 54;
  const right = rect.x + rect.width - 22;
  const width = right - left;
  const height = bottom - top;
  const maxValue = Math.max(1, ...view.districts.map((district) => district.flow));
  const slot = width / view.districts.length;
  const barWidth = Math.min(68, slot * 0.5);

  for (let index = 0; index <= 3; index += 1) {
    const ratio = index / 3;
    const y = bottom - height * ratio;
    line(ctx, left, y, right, y, "rgba(25,33,28,0.12)", 1);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(400, 11);
    ctx.textAlign = "right";
    ctx.fillText(formatCompact(maxValue * ratio), left - 8, y + 4);
  }
  line(ctx, left, bottom, right, bottom, COLORS.ink, 1);
  ctx.textAlign = "center";
  view.districts.forEach((district, index) => {
    const centerX = left + slot * index + slot / 2;
    const busHeight = (district.busRiders / maxValue) * height;
    const otherHeight = (district.otherRiders / maxValue) * height;
    ctx.fillStyle = "#c7c2b5";
    ctx.fillRect(centerX - barWidth / 2, bottom - otherHeight, barWidth, otherHeight);
    ctx.fillStyle = COLORS.blue;
    ctx.fillRect(centerX - barWidth / 2, bottom - otherHeight - busHeight, barWidth, busHeight);
    ctx.fillStyle = COLORS.muted;
    ctx.font = font(400, 11);
    ctx.fillText(district.name, centerX, bottom + 17);
    ctx.fillStyle = COLORS.ink;
    ctx.font = font(700, 10);
    ctx.fillText(formatPct(district.transitShare), centerX, bottom - otherHeight - busHeight - 7);
  });
  ctx.textAlign = "left";
}

function drawChart(ctx, view, chapterId, rect) {
  ctx.fillStyle = COLORS.ink;
  ctx.font = font(700, 17);
  ctx.fillText(
    chapterId === "flow" ? "逐小时流量 / 堆叠柱" : chapterId === "speed" ? "走廊速度排行 / 独立强度" : "片区出行结构 / 堆叠柱",
    rect.x,
    rect.y - 12
  );
  if (chapterId === "speed") drawSpeedChart(ctx, view, rect);
  else if (chapterId === "transit") drawTransitChart(ctx, view, rect);
  else drawFlowChart(ctx, view, rect);
}

function drawMetricCard(ctx, metric, x, y, width, height) {
  ctx.fillStyle = COLORS.paperBright;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(500, 11);
  ctx.fillText(metric.label, x + 14, y + 21);
  ctx.fillStyle = COLORS.ink;
  ctx.font = font(800, 24);
  ctx.fillText(metric.value, x + 14, y + 52);
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(400, 10);
  ctx.fillText(metric.unit, x + 14, y + 69);
}

function drawRightPanel(ctx, dataset, view, chapter, filters, manifest, narrative, rect) {
  ctx.fillStyle = COLORS.paperBright;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);

  ctx.fillStyle = COLORS.accent;
  ctx.font = font(700, 11);
  ctx.fillText("SYNCHRONIZED MAP", rect.x + 20, rect.y + 27);
  ctx.fillStyle = COLORS.ink;
  ctx.font = font(800, 20);
  ctx.fillText("临江交通脉络", rect.x + 20, rect.y + 52);
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(400, 10);
  ctx.textAlign = "right";
  ctx.fillText(
    chapter.id === "speed" ? "颜色 = 加权速度" : chapter.id === "transit" ? "圆点 = 公交分担" : "线宽 = 当前流量",
    rect.x + rect.width - 20,
    rect.y + 52
  );
  ctx.textAlign = "left";
  drawMap(ctx, dataset, view, chapter.id, filters, {
    x: rect.x + 20,
    y: rect.y + 68,
    width: rect.width - 40,
    height: 362
  });

  ctx.fillStyle = COLORS.muted;
  ctx.font = font(400, 10);
  drawWrapped(ctx, narrative.summary, rect.x + 20, rect.y + 454, rect.width - 40, 15, 3);

  line(ctx, rect.x + 20, rect.y + 500, rect.x + rect.width - 20, rect.y + 500, COLORS.line, 1);

  ctx.fillStyle = COLORS.muted;
  ctx.font = font(500, 10);
  ctx.fillText("当前筛选", rect.x + 20, rect.y + 524);
  ctx.fillStyle = COLORS.ink;
  ctx.font = font(700, 13);
  drawWrapped(ctx, view.filterSummary, rect.x + 20, rect.y + 544, rect.width - 40, 19, 2);

  const versionY = rect.y + 584;
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(500, 10);
  ctx.fillText("数据版本 / 发布日期", rect.x + 20, versionY);
  ctx.fillStyle = COLORS.ink;
  ctx.font = font(700, 12);
  ctx.fillText(`${dataset.version} · ${dataset.releasedAt.slice(0, 10)}`, rect.x + 20, versionY + 20);

  const scopeY = rect.y + 622;
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(500, 10);
  ctx.fillText("导出口径", rect.x + 20, scopeY);
  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = font(400, 10);
  drawWrapped(ctx, manifest.exportScope, rect.x + 20, scopeY + 18, rect.width - 40, 15, 3);

  const summaryY = rect.y + 686;
  line(ctx, rect.x + 20, summaryY, rect.x + rect.width - 20, summaryY, COLORS.line, 1);
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(500, 10);
  ctx.fillText("关键数值 / 导出前后核对", rect.x + 20, summaryY + 18);
  ctx.fillStyle = COLORS.ink;
  ctx.font = font(500, 11);
  ctx.fillText(`对象 ${formatNumber(manifest.objectCount)} 条`, rect.x + 20, summaryY + 40);
  ctx.fillText(`总流量 ${formatNumber(view.totalFlow)}`, rect.x + 190, summaryY + 40);
  ctx.fillText(`均速 ${formatSpeed(view.avgSpeed)} km/h`, rect.x + 20, summaryY + 60);
  ctx.fillText(`公交 ${formatNumber(view.busRiders)}`, rect.x + 190, summaryY + 60);
  ctx.fillStyle = COLORS.teal;
  ctx.font = font(500, 9);
  ctx.fillText(manifest.dataHash, rect.x + 20, summaryY + 84);
}

function drawFooter(ctx, manifest, noMotion) {
  ctx.fillStyle = COLORS.dark;
  ctx.fillRect(0, 936, 1600, 64);
  ctx.fillStyle = COLORS.paperBright;
  ctx.font = font(500, 10);
  ctx.fillText(manifest.filterSummary, 58, 962);
  ctx.fillStyle = "#90a096";
  ctx.font = font(400, 9);
  ctx.fillText(
    `${manifest.datasetVersion} · ${manifest.kind} · 对象 ${manifest.objectCount} · ${noMotion ? "无动画模式" : "标准模式"} · ${manifest.dataHash}`,
    58,
    981
  );
  ctx.textAlign = "right";
  ctx.fillStyle = COLORS.paperBright;
  ctx.font = font(700, 10);
  ctx.fillText("城市脉冲 / CITY PULSE", 1542, 972);
  ctx.textAlign = "left";
}

function drawReport(ctx, { dataset, view, chapter, narrative, filters, manifest, noMotion }) {
  drawPageBackground(ctx);
  drawHeader(ctx, dataset, manifest, chapter);

  const left = 58;
  ctx.fillStyle = COLORS.accent;
  ctx.font = font(700, 11);
  ctx.fillText(`CHAPTER ${chapter.number} / ${chapter.kicker}`, left, 164);

  ctx.fillStyle = COLORS.ink;
  ctx.font = font(800, 58);
  ctx.fillText(chapter.title, left, 226);
  line(ctx, left, 248, 900, 248, COLORS.ink, 1);

  ctx.fillStyle = COLORS.ink;
  ctx.font = font(700, 27);
  drawWrapped(ctx, narrative.summary, left, 292, 844, 38, 3);

  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = font(400, 16);
  const ledeEnd = drawWrapped(ctx, narrative.lede, left, 410, 844, 27, 4);
  ctx.fillStyle = COLORS.muted;
  ctx.font = font(400, 13);
  drawWrapped(ctx, narrative.paragraphs[0] ?? "", left, ledeEnd + 18, 810, 23, 3);

  const metricY = 518;
  narrative.metrics.forEach((metric, index) => {
    drawMetricCard(ctx, metric, left + index * 286, metricY, 270, 82);
  });

  drawChart(ctx, view, chapter.id, { x: left + 2, y: 692, width: 836, height: 220 });

  drawRightPanel(ctx, dataset, view, chapter, filters, manifest, narrative, {
    x: 970,
    y: 145,
    width: 572,
    height: 772
  });
  drawFooter(ctx, manifest, noMotion);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function pngWithManifest(dataUrl, manifest, keyword = "city-pulse-manifest") {
  const base64 = dataUrl.split(",")[1];
  const original = base64ToBytes(base64);
  const iendOffset = original.length - 12;
  const textBytes = new TextEncoder().encode(`${keyword}\0${utf8ToBase64(JSON.stringify(manifest))}`);
  const chunk = new Uint8Array(12 + textBytes.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, textBytes.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(textBytes, 8);
  const crc = crc32(chunk.slice(4, 8 + textBytes.length));
  view.setUint32(8 + textBytes.length, crc);

  const combined = new Uint8Array(original.length + chunk.length);
  combined.set(original.slice(0, iendOffset), 0);
  combined.set(chunk, iendOffset);
  combined.set(original.slice(iendOffset), iendOffset + chunk.length);
  let binary = "";
  for (const byte of combined) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

export function manifestFromPng(dataUrl, keyword = "city-pulse-manifest") {
  const bytes = base64ToBytes(dataUrl.split(",")[1]);
  let offset = 8;
  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    if (type === "tEXt") {
      const separator = data.indexOf(0);
      const foundKeyword = String.fromCharCode(...data.slice(0, separator));
      if (foundKeyword === keyword) {
        const base64Json = String.fromCharCode(...data.slice(separator + 1));
        const decoded = base64ToBytes(base64Json);
        return JSON.parse(new TextDecoder().decode(decoded));
      }
    }
    offset += 12 + length;
  }
  return null;
}

export function exportFilename(manifest) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `城市脉冲_${manifest.chapterTitle}_${stamp}.png`;
}

export async function createChapterPng(options) {
  await document.fonts.ready;
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1000;
  const ctx = canvas.getContext("2d");
  const chapter = chapterById(options.chapterId);
  drawReport(ctx, { ...options, chapter });
  const rawDataUrl = canvas.toDataURL("image/png");
  const dataUrl = pngWithManifest(rawDataUrl, options.manifest);
  const bytes = base64ToBytes(dataUrl.split(",")[1]);
  return {
    dataUrl,
    blob: new Blob([bytes], { type: "image/png" }),
    filename: exportFilename(options.manifest),
    manifest: manifestFromPng(dataUrl)
  };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
