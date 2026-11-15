const BACKGROUND = 255;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function blend(target, index, intensity, alpha) {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  target[index] = target[index] + (intensity - target[index]) * a;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawSegment(raster, width, height, segment) {
  const { x1, y1, x2, y2, stroke = 1, ink = 24 } = segment;
  const half = stroke / 2;
  const minX = Math.max(0, Math.floor(Math.min(x1, x2) - half - 1));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x1, x2) + half + 1));
  const minY = Math.max(0, Math.floor(Math.min(y1, y2) - half - 1));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y1, y2) + half + 1));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = segmentDistance(x + 0.5, y + 0.5, x1, y1, x2, y2);
      const coverage = clamp(half + 0.5 - distance, 0, 1);
      blend(raster, y * width + x, ink, coverage);
    }
  }
}

function drawPolyline(raster, width, height, points, options) {
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1];
    const [x2, y2] = points[index];
    drawSegment(raster, width, height, { x1, y1, x2, y2, ...options });
  }
}

function drawRing(raster, width, height, cx, cy, radius, options) {
  const steps = Math.max(48, Math.ceil(radius * 2.2));
  let previous = [cx + radius, cy];
  for (let index = 1; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2;
    const next = [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius];
    drawSegment(raster, width, height, {
      x1: previous[0],
      y1: previous[1],
      x2: next[0],
      y2: next[1],
      ...options
    });
    previous = next;
  }
}

function blankRaster(width, height) {
  const raster = new Float32Array(width * height);
  raster.fill(BACKGROUND);
  return raster;
}

function drawStructure(targets, width, height) {
  const primitives = [
    {
      kind: "polyline",
      points: [[82, 356], [194, 278], [332, 292], [478, 196], [628, 238]],
      options: { stroke: 2.35, ink: 26 }
    },
    {
      kind: "polyline",
      points: [[140, 402], [240, 264], [382, 112], [566, 76]],
      options: { stroke: 1.05, ink: 52 }
    },
    {
      kind: "polyline",
      points: [[106, 104], [274, 238], [442, 362], [634, 404]],
      options: { stroke: 1.25, ink: 42 }
    },
    {
      kind: "polyline",
      points: [[356, 42], [354, 166], [362, 302], [358, 438]],
      options: { stroke: 0.9, ink: 62 }
    },
    {
      kind: "polyline",
      points: [[64, 224], [186, 211], [304, 230], [430, 204], [548, 224], [662, 208]],
      options: { stroke: 1.15, ink: 48 }
    },
    {
      kind: "ring",
      cx: 354,
      cy: 230,
      radius: 64,
      options: { stroke: 1.1, ink: 56 }
    },
    {
      kind: "ring",
      cx: 522,
      cy: 310,
      radius: 31,
      options: { stroke: 1.8, ink: 30 }
    },
    {
      kind: "polyline",
      points: [[492, 298], [540, 287], [576, 322], [552, 354], [510, 342]],
      options: { stroke: 1.35, ink: 38 }
    },
    {
      kind: "polyline",
      points: [[204, 96], [198, 158], [224, 176], [260, 170]],
      options: { stroke: 0.8, ink: 66 }
    }
  ];

  for (const primitive of primitives) {
    if (primitive.kind === "ring") {
      for (const target of targets) {
        drawRing(target, width, height, primitive.cx, primitive.cy, primitive.radius, primitive.options);
      }
    } else {
      for (const target of targets) {
        drawPolyline(target, width, height, primitive.points, primitive.options);
      }
    }
  }
}

function drawIsolatedSpecks(raster, width, height) {
  const specks = [
    [92, 72, 1.2, 8],
    [152, 58, 0.9, 22],
    [534, 92, 1.5, 0],
    [582, 134, 1.0, 34],
    [624, 330, 1.7, 14],
    [458, 430, 1.1, 18],
    [246, 420, 1.3, 5],
    [688, 248, 0.8, 46],
    [92, 396, 1.0, 20],
    [274, 66, 1.6, 16],
    [430, 452, 0.9, 54],
    [640, 184, 1.2, 7]
  ];
  for (const [cx, cy, radius, ink] of specks) {
    const start = Math.max(0, Math.floor(cy - radius - 2));
    const end = Math.min(height - 1, Math.ceil(cy + radius + 2));
    const left = Math.max(0, Math.floor(cx - radius - 2));
    const right = Math.min(width - 1, Math.ceil(cx + radius + 2));
    for (let y = start; y <= end; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const coverage = clamp(radius + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy), 0, 1);
        blend(raster, y * width + x, ink, coverage);
      }
    }
  }
}

function maskFromRaster(raster, threshold) {
  const mask = new Uint8Array(raster.length);
  for (let index = 0; index < raster.length; index += 1) {
    mask[index] = raster[index] <= threshold ? 1 : 0;
  }
  return mask;
}

export function createCrossingSample(width = 720, height = 480) {
  const gray = blankRaster(width, height);
  const structureGray = blankRaster(width, height);
  const thinGray = blankRaster(width, height);
  drawStructure([gray, structureGray, thinGray], width, height);
  drawIsolatedSpecks(gray, width, height);

  return {
    id: "crossing-speck-v1",
    name: "交叉线束 / 孤立斑点",
    description: "1px 细线、交叉线、环线以及 12 个互不相连的深色斑点。",
    width,
    height,
    gray,
    referenceMask: maskFromRaster(structureGray, 214),
    thinLineMask: maskFromRaster(thinGray, 214),
    speckMask: maskFromRaster(gray, 214).map((value, index) => (
      structureGray[index] <= 214 ? 0 : value
    ))
  };
}

export function rasterFromImageData(imageData) {
  const { width, height, data } = imageData;
  const gray = new Float32Array(width * height);
  const referenceMask = new Uint8Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    const luminance = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    gray[index] = luminance;
    referenceMask[index] = luminance <= 214 ? 1 : 0;
  }
  return {
    id: "uploaded-image",
    name: "导入线稿",
    description: "从本地图片读取的灰度线稿。",
    width,
    height,
    gray,
    referenceMask,
    thinLineMask: referenceMask,
    speckMask: new Uint8Array(width * height)
  };
}

export const SAMPLE_WIDTH = 720;
export const SAMPLE_HEIGHT = 480;
