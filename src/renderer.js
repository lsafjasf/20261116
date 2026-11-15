import {
  clamp,
  fbm,
  hash2i,
  hexToRgb,
  interpolateKeyframes,
  mixRgb,
  mod,
  periodicSignal,
  periodicWorley,
  stableHash
} from "./core.js";

const materialCache = new Map();
const thumbCache = new Map();
let cacheGeneration = 0;

function numeric(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}

function validColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

function makeCanvas(size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function cacheKey(layer, size, time) {
  return stableHash({
    generation: cacheGeneration,
    layerId: layer.id,
    kind: layer.kind,
    seed: layer.seed,
    params: layer.params,
    palette: layer.palette,
    size,
    time: Math.round(time),
    keyframes: layer.keyframes
  });
}

function resolveStoneColors(layer) {
  return {
    base: hexToRgb(validColor(layer.palette?.base, "#817d73")),
    vein: hexToRgb(validColor(layer.palette?.vein, "#45433e")),
    accent: hexToRgb(validColor(layer.palette?.accent, "#c29a65"))
  };
}

function renderStone(layer, size, currentTime) {
  const canvas = makeCanvas(size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.createImageData(size, size);
  const data = image.data;
  const colors = resolveStoneColors(layer);
  const params = {
    scale: numeric(layer.params?.scale ?? 7, 7, 3, 16),
    contrast: numeric(layer.params?.contrast ?? 0.58, 0.58, 0, 1),
    grain: numeric(layer.params?.grain ?? 0.28, 0.28, 0, 1),
    weather: numeric(layer.params?.weather ?? 0.22, 0.22, 0, 1)
  };
  const evolution = interpolateKeyframes(layer.keyframes || [], currentTime);
  const weather = clamp(params.weather + (evolution.weather || 0) * 0.48, 0, 1);
  const seed = layer.seed | 0;
  const cellCount = Math.round(params.scale);
  const edgeSoftness = 3.1 + params.contrast * 3.5;

  for (let py = 0; py < size; py += 1) {
    const y = (py + 0.5) / size;
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const cell = periodicWorley(x, y, cellCount, seed);
      const broad = fbm(x, y, 3, seed + 211, 4);
      const medium = fbm(x, y, 13, seed + 503, 4);
      const fine = fbm(x, y, 47, seed + 809, 3);
      const directional = periodicSignal(x, y, 2, 5, 0.17);
      const cellTone = hash2i(cell.cellX, cell.cellY, seed + 41);
      const cellTint = hash2i(cell.cellX, cell.cellY, seed + 97);
      const seam = 1 - clamp(cell.edge * edgeSoftness);
      const veinField = 1 - clamp(Math.abs(medium - 0.51) * (20 - params.contrast * 6));
      const vein = clamp(seam * 0.84 + veinField * 0.32);
      const weathered = clamp((broad - 0.42) * 2.2 + weather * 0.4);
      const tone =
        0.78 +
        (cellTone - 0.5) * 0.23 +
        (broad - 0.5) * (0.11 + params.contrast * 0.17) +
        (medium - 0.5) * 0.19 +
        directional * 0.025 +
        (fine - 0.5) * params.grain * 0.24 +
        weathered * 0.05;
      const base = colors.base.map((value) => value * tone);
      let color = mixRgb(base, colors.vein, vein * (0.62 + params.contrast * 0.2));
      const mineral = clamp((fine - 0.67) * 7) * cellTint * (0.1 + params.grain * 0.32);
      color = mixRgb(color, colors.accent, mineral);
      color = mixRgb(color, colors.vein, clamp((fine - 0.73) * 3.4) * params.grain * 0.22);
      const light = 1.01 + (cell.d1 - 0.5) * 0.09;
      const index = (py * size + px) * 4;
      data[index] = clamp(color[0] * light, 0, 255);
      data[index + 1] = clamp(color[1] * light, 0, 255);
      data[index + 2] = clamp(color[2] * light, 0, 255);
      data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function renderFabric(layer, size, currentTime) {
  const canvas = makeCanvas(size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.createImageData(size, size);
  const data = image.data;
  const base = hexToRgb(validColor(layer.palette?.base, "#77786c"));
  const vein = hexToRgb(validColor(layer.palette?.vein, "#373a33"));
  const accent = hexToRgb(validColor(layer.palette?.accent, "#c9b89c"));
  const params = {
    threads: Math.round(numeric(layer.params?.threads ?? 48, 48, 12, 128)),
    slub: numeric(layer.params?.slub ?? 0.24, 0.24, 0, 1),
    wrinkle: numeric(layer.params?.wrinkle ?? 0.3, 0.3, 0, 1),
    contrast: numeric(layer.params?.contrast ?? 0.52, 0.52, 0, 1)
  };
  const evolution = interpolateKeyframes(layer.keyframes || [], currentTime);
  const slub = clamp(params.slub + (evolution.slub || 0) * 0.22, 0, 1);
  const seed = layer.seed | 0;
  const threads = params.threads;

  for (let py = 0; py < size; py += 1) {
    const y = (py + 0.5) / size;
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const u = x * threads;
      const v = y * threads;
      const ix = Math.floor(u);
      const iy = Math.floor(v);
      const fx = u - ix;
      const fy = v - iy;
      const over = mod(ix + iy, 2) === 0;
      const warp = Math.sin(fx * Math.PI);
      const weft = Math.sin(fy * Math.PI);
      const topWarp = over ? warp : warp * 0.42;
      const topWeft = over ? weft * 0.42 : weft;
      const groove = Math.max(topWarp, topWeft);
      const slubNoise = fbm(x, y, 11, seed + 1049, 3);
      const wrinkle = fbm(x, y, 3, seed + 1301, 4);
      const fiber = fbm(x, y, 73, seed + 1709, 2);
      const grain = hash2i(mod(ix, threads), mod(iy, threads), seed + 33);
      const threadVariation = (grain - 0.5) * params.contrast * 0.2;
      const slubness = clamp((slubNoise - 0.35) * 1.7) * slub;
      const shade =
        0.34 +
        groove * (0.42 + params.contrast * 0.25) +
        threadVariation +
        (fiber - 0.5) * 0.11 +
        (wrinkle - 0.5) * params.wrinkle * 0.23 +
        (fy - 0.5) * 0.03;
      let color = base.map((value) => value * shade);
      const threadHighlight = clamp((groove - 0.58) * 2.2);
      color = mixRgb(color, accent, threadHighlight * 0.16 + slubness * 0.2);
      color = mixRgb(color, vein, clamp((1 - groove) * 0.64 + (1 - shade) * 0.22));
      const weaveShadow = clamp(Math.abs(fx - 0.5) * 2) * 0.04;
      const index = (py * size + px) * 4;
      data[index] = clamp(color[0] * (1 - weaveShadow), 0, 255);
      data[index + 1] = clamp(color[1] * (1 - weaveShadow), 0, 255);
      data[index + 2] = clamp(color[2] * (1 - weaveShadow), 0, 255);
      data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function getMaterialCanvas(layer, size, scene, options = {}) {
  const prepared = { ...layer, keyframes: scene.keyframes || [] };
  const key = cacheKey(prepared, size, scene.currentTime);
  const cached = materialCache.get(key);
  if (cached) {
    if (cached.width === size && cached.height === size) return cached;
    materialCache.delete(key);
    if (!options.quiet) throw new Error("材质缓存尺寸校验失败");
  }
  const nativeSize = Math.min(size, 512);
  const nativeKey = cacheKey(prepared, nativeSize, scene.currentTime);
  let native = materialCache.get(nativeKey);
  if (!native || native.width !== nativeSize || native.height !== nativeSize) {
    native = prepared.kind === "fabric"
      ? renderFabric(prepared, nativeSize, scene.currentTime)
      : renderStone(prepared, nativeSize, scene.currentTime);
    materialCache.set(nativeKey, native);
  }
  if (nativeSize === size) return native;
  const canvas = makeCanvas(size);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(native, 0, 0, size, size);
  materialCache.set(key, canvas);
  return canvas;
}

export function clearMaterialCache() {
  const count = materialCache.size;
  materialCache.clear();
  cacheGeneration += 1;
  return count;
}

export function clearThumbnailCache() {
  const count = thumbCache.size;
  thumbCache.clear();
  return count;
}

export function renderLayerThumbnail(layer, scene, fallback = false) {
  const key = stableHash({
    cache: "thumb",
    layerId: layer.id,
    type: layer.type,
    visible: layer.visible,
    opacity: layer.opacity,
    strokes: layer.strokes?.length,
    time: Math.round(scene.currentTime),
    fallback
  });
  if (!fallback && thumbCache.has(key)) return thumbCache.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = 78;
  canvas.height = 78;
  const context = canvas.getContext("2d");
  if (layer.type === "material") {
    const source = getMaterialCanvas(layer, 96, scene, { quiet: fallback });
    context.drawImage(source, 0, 0, 78, 78);
  } else {
    context.fillStyle = "#26231e";
    context.fillRect(0, 0, 78, 78);
    drawBrushLayer(context, layer, 78, { preview: true });
  }
  if (!fallback) thumbCache.set(key, canvas);
  return canvas;
}

const stampCache = new Map();

function getBrushStamp(color, radius, hardness) {
  const key = `${color}-${Math.round(radius)}-${Math.round(hardness * 20)}`;
  if (stampCache.has(key)) return stampCache.get(key);
  const pad = 3;
  const diameter = Math.max(3, Math.ceil(radius * 2 + pad * 2));
  const canvas = document.createElement("canvas");
  canvas.width = diameter;
  canvas.height = diameter;
  const context = canvas.getContext("2d");
  const center = diameter / 2;
  const gradient = context.createRadialGradient(center, center, 0, center, center, radius);
  const rgb = hexToRgb(color);
  gradient.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
  gradient.addColorStop(clamp(hardness, 0.01, 0.99), `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.92)`);
  gradient.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, diameter, diameter);
  stampCache.set(key, canvas);
  return canvas;
}

function repeatOffsets(points) {
  if (!points.length) return [0];
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const offsets = [];
  for (let oy = Math.floor(-maxY); oy <= Math.ceil(1 - minY); oy += 1) {
    for (let ox = Math.floor(-maxX); ox <= Math.ceil(1 - minX); ox += 1) {
      offsets.push([ox, oy]);
    }
  }
  return offsets.slice(0, 25);
}

function drawStroke(context, stroke, size) {
  if (!stroke.points?.length) return;
  const scale = size / 1024;
  const radius = Math.max(1, Number(stroke.size || 28) * scale * 0.5);
  const stamp = getBrushStamp(stroke.color || "#d8b074", radius, Number(stroke.hardness ?? 0.65));
  const spacing = Math.max(1.1, radius * 0.24);
  const offsets = repeatOffsets(stroke.points);
  context.save();
  context.globalAlpha = clamp(Number(stroke.opacity ?? 0.55), 0.01, 1);
  for (const [ox, oy] of offsets) {
    const shiftX = ox * size;
    const shiftY = oy * size;
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      context.drawImage(stamp, point.x * size + shiftX - stamp.width / 2, point.y * size + shiftY - stamp.height / 2);
      continue;
    }
    for (let i = 1; i < stroke.points.length; i += 1) {
      const from = stroke.points[i - 1];
      const to = stroke.points[i];
      const dx = (to.x - from.x) * size;
      const dy = (to.y - from.y) * size;
      const distance = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(distance / spacing));
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const x = (from.x + (to.x - from.x) * t) * size + shiftX;
        const y = (from.y + (to.y - from.y) * t) * size + shiftY;
        context.drawImage(stamp, x - stamp.width / 2, y - stamp.height / 2);
      }
    }
  }
  context.restore();
}

export function drawBrushLayer(context, layer, size, options = {}) {
  context.save();
  context.globalAlpha *= layer.opacity ?? 1;
  for (const stroke of layer.strokes || []) drawStroke(context, stroke, size);
  context.restore();
  if (options.selection && layer.strokes?.length) {
    context.save();
    context.strokeStyle = "rgba(206,149,96,.18)";
    context.setLineDash([2, 4]);
    context.strokeRect(1, 1, size - 2, size - 2);
    context.restore();
  }
}

export function renderScene(scene, size, options = {}) {
  const canvas = makeCanvas(size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#5d5950";
  context.fillRect(0, 0, size, size);
  const visibleLayers = scene.layers.filter((layer) => layer.visible && layer.opacity > 0);
  for (const layer of visibleLayers) {
    context.save();
    context.globalAlpha = layer.opacity;
    try {
      if (layer.type === "material") {
        const material = getMaterialCanvas(layer, size, scene, { quiet: options.quiet });
        context.drawImage(material, 0, 0);
      } else {
        drawBrushLayer(context, layer, size);
      }
    } catch (error) {
      if (options.quiet) {
        context.fillStyle = layer.kind === "fabric" ? "#6b6b60" : "#6e6a61";
        context.fillRect(0, 0, size, size);
      } else {
        throw error;
      }
    }
    context.restore();
  }
  return canvas;
}

function pixelDifference(data, width, x1, y1, x2, y2) {
  const i1 = (y1 * width + x1) * 4;
  const i2 = (y2 * width + x2) * 4;
  return (
    Math.abs(data[i1] - data[i2]) +
    Math.abs(data[i1 + 1] - data[i2 + 1]) +
    Math.abs(data[i1 + 2] - data[i2 + 2])
  ) / 3;
}

export function measureSeams(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const data = context.getImageData(0, 0, width, height).data;
  let seamX = 0;
  let seamY = 0;
  const interiorX = [];
  const interiorY = [];
  const rows = 32;
  const columns = 32;
  const step = 1;
  for (let i = 0; i < rows; i += 1) {
    const y = Math.floor((i + 0.5) * height / rows);
    seamX += pixelDifference(data, width, width - 1, y, 0, y);
    for (let x = 2; x < width - 2; x += step) {
      interiorX.push(pixelDifference(data, width, x, y, x + 1, y));
    }
  }
  for (let i = 0; i < columns; i += 1) {
    const x = Math.floor((i + 0.5) * width / columns);
    seamY += pixelDifference(data, width, x, height - 1, x, 0);
    for (let y = 2; y < height - 2; y += step) {
      interiorY.push(pixelDifference(data, width, x, y, x, y + 1));
    }
  }
  seamX /= rows;
  seamY /= columns;
  const percentile = (values, ratio) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  };
  const interiorXP = Math.max(1, percentile(interiorX, 0.99));
  const interiorYP = Math.max(1, percentile(interiorY, 0.99));
  const ratio = (seamX / interiorXP + seamY / interiorYP) * 0.5;
  return {
    horizontal: Number(seamX.toFixed(2)),
    vertical: Number(seamY.toFixed(2)),
    interior: Number(((interiorXP + interiorYP) * 0.5).toFixed(2)),
    ratio: Number(ratio.toFixed(2)),
    passes: ratio < 1.65
  };
}

export function resizeCanvas(source, size) {
  const canvas = makeCanvas(size);
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, size, size);
  return canvas;
}

export function compareCanvases(first, second) {
  const width = Math.min(first.width, second.width);
  const a = first.width === width ? first : resizeCanvas(first, width);
  const b = second.width === width ? second : resizeCanvas(second, width);
  const aData = a.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, width).data;
  const bData = b.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, width).data;
  let total = 0;
  let worst = 0;
  let squared = 0;
  let diffPixels = 0;
  const channels = width * width * 3;
  for (let i = 0; i < aData.length; i += 4) {
    const dr = aData[i] - bData[i];
    const dg = aData[i + 1] - bData[i + 1];
    const db = aData[i + 2] - bData[i + 2];
    const delta = (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) / 3;
    total += delta;
    squared += dr * dr + dg * dg + db * db;
    worst = Math.max(worst, delta);
    if (delta > 2) diffPixels += 1;
  }
  const mae = total / (width * width);
  const mse = squared / channels;
  return {
    size: width,
    mae: Number(mae.toFixed(3)),
    psnr: Number((10 * Math.log10(255 * 255 / Math.max(0.001, mse))).toFixed(2)),
    maxDelta: Number(worst.toFixed(1)),
    changedPercent: Number((diffPixels / (width * width) * 100).toFixed(2)),
    passes: mae < 7
  };
}

export function buildTileCheck(source) {
  const gap = 0;
  const canvas = document.createElement("canvas");
  canvas.width = source.width * 2 + gap;
  canvas.height = source.height * 2 + gap;
  const context = canvas.getContext("2d");
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 2; x += 1) {
      context.drawImage(source, x * source.width, y * source.height);
    }
  }
  return canvas;
}

function drawLabel(context, text, x, y, color = "#e8e0d2") {
  context.fillStyle = "rgba(12,11,9,.82)";
  context.fillRect(x - 7, y - 6, Math.ceil(context.measureText(text).width) + 14, 18);
  context.fillStyle = color;
  context.fillText(text, x, y + 6);
}

export function buildComparisonReport(direct, downscaled, diff) {
  const panel = 360;
  const header = 50;
  const footer = 44;
  const canvas = document.createElement("canvas");
  canvas.width = panel * 3 + 32;
  canvas.height = panel + header + footer;
  const context = canvas.getContext("2d");
  context.fillStyle = "#11100d";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "12px monospace";
  context.fillStyle = "#ce9560";
  context.fillText("SEAMLAB / RESAMPLE CONSISTENCY REPORT", 16, 20);
  context.fillStyle = "#777064";
  context.font = "10px monospace";
  context.fillText(`MAE ${diff.mae.toFixed(3)} / 255   PSNR ${diff.psnr.toFixed(2)} dB   CHANGED ${diff.changedPercent.toFixed(2)}%`, 16, 37);
  const labels = ["A · 512 DIRECT", "B · 1024 → 512", "|A − B| × 4"];
  const diffCanvas = createDiffPreview(direct, downscaled);
  const panels = [direct, downscaled, diffCanvas];
  panels.forEach((source, index) => {
    const x = 16 + index * panel;
    context.drawImage(source, x, header, panel, panel);
    context.fillStyle = "#d8d0c2";
    context.font = "10px monospace";
    drawLabel(context, labels[index], x + 10, header + 8);
  });
  context.fillStyle = "#777064";
  context.font = "10px monospace";
  context.fillText("Same normalized scene · 1024 box-filtered to 512 vs direct 512 · no post seam correction", 16, canvas.height - 16);
  context.fillStyle = diff.passes ? "#7fb69c" : "#df8e6f";
  context.fillText(diff.passes ? "PASS · VISUALLY CONSISTENT" : "REVIEW · ERROR ABOVE THRESHOLD", canvas.width - 270, canvas.height - 16);
  return canvas;
}

function createDiffPreview(first, second) {
  const size = Math.min(first.width, second.width);
  const a = first.width === size ? first : resizeCanvas(first, size);
  const b = second.width === size ? second : resizeCanvas(second, size);
  const canvas = makeCanvas(size);
  const context = canvas.getContext("2d");
  const aData = a.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, size, size);
  const bData = b.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, size, size);
  const out = context.createImageData(size, size);
  for (let i = 0; i < aData.data.length; i += 4) {
    out.data[i] = clamp(Math.abs(aData.data[i] - bData.data[i]) * 4, 0, 255);
    out.data[i + 1] = clamp(Math.abs(aData.data[i + 1] - bData.data[i + 1]) * 4, 0, 255);
    out.data[i + 2] = clamp(Math.abs(aData.data[i + 2] - bData.data[i + 2]) * 4, 0, 255);
    out.data[i + 3] = 255;
  }
  context.putImageData(out, 0, 0);
  return canvas;
}

export async function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("浏览器未能编码 PNG"));
    }, type);
  });
}

export function canvasDataUrl(canvas) {
  return canvas.toDataURL("image/png");
}
