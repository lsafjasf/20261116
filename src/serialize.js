import { hashCanvas, hashString } from "./config.js";
import { createCanvas, layoutFor } from "./atlas.js";
import { analyzeCanvas, pixelHashFromCanvas } from "./measure.js";

export function buildIndex(scene, config, metrics, view, stateSummary = null) {
  const layout = layoutFor(config);
  const sorted = [...scene].sort((a, b) => a.slot - b.slot);
  const shapes = sorted.map((entry) => {
    const slot = layout.slots[entry.slot];
    const rect = slot.contentRect;
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      seed: entry.seed,
      hue: entry.hue,
      slot: entry.slot,
      grid: { col: slot.col, row: slot.row },
      transform: { scale: entry.scale, rotation: entry.rotation },
      shadow: { blur: entry.shadowBlur, dx: entry.shadowDx, dy: entry.shadowDy },
      rect,
      uv: {
        u0: rect.x / config.width,
        v0: rect.y / config.height,
        u1: (rect.x + rect.w) / config.width,
        v1: (rect.y + rect.h) / config.height,
      },
      alphaBounds: metrics.alphaBounds[entry.id] || null,
    };
  });

  return {
    format: "shadow-atlas/v1",
    generatedAt: new Date().toISOString(),
    atlas: {
      width: config.width,
      height: config.height,
      cellSize: config.cell,
      edgePadding: config.padding,
      cols: layout.cols,
      rows: layout.rows,
      capacity: layout.capacity,
    },
    texture: {
      hash: metrics.hash,
      width: config.width,
      height: config.height,
      colorSpace: "srgb",
    },
    sampling: {
      filter: view.sampler,
      wrap: "clamp-to-edge",
      sampleRect: "contentRect",
    },
    algorithm: {
      packer: "fixed-grid",
      isolation: "content-clip+1px-transparent-guard",
      guardPx: 1,
      dirtyPolicy: "slot-union",
      deterministicShapePaths: true,
    },
    preset: {
      sampler: view.sampler,
      zoom: view.zoom,
      edgePadding: config.padding,
      guard: view.guard,
      checker: "#101d23",
    },
    stats: {
      objects: scene.length,
      occupiedSlots: metrics.occupiedSlots,
      capacity: metrics.capacity,
      slotRatio: metrics.slotRatio,
      fillRatio: metrics.fillRatio,
      fillPixels: metrics.fillPixels,
      guardViolations: metrics.guardViolations,
    },
    shapeCount: shapes.length,
    shapes,
    stateSummary,
  };
}

export function restoreEntries(index) {
  if (!index || !Array.isArray(index.shapes)) throw new Error("索引缺少 shapes 数组");
  return index.shapes.map((shape) => ({
    id: shape.id,
    name: shape.name,
    kind: shape.kind,
    seed: shape.seed,
    hue: shape.hue,
    slot: shape.slot,
    scale: shape.transform.scale,
    rotation: shape.transform.rotation,
    shadowBlur: shape.shadow.blur,
    shadowDx: shape.shadow.dx,
    shadowDy: shape.shadow.dy,
  }));
}

export function configFromIndex(index) {
  const atlas = index.atlas;
  return {
    width: atlas.width,
    height: atlas.height,
    cell: atlas.cellSize,
    padding: atlas.edgePadding,
  };
}

export function validateReloadedAtlas(canvas, index, expectedEntries = null) {
  const config = configFromIndex(index);
  const entries = restoreEntries(index);
  const layout = layoutFor(config);
  const metrics = analyzeCanvas(canvas, entries, config);
  const pixels = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const sourceById = new Map((expectedEntries || []).map((entry) => [entry.id, entry]));
  const seenIds = new Set();
  const seenSlots = new Set();
  const items = index.shapes.map((shape) => {
    const slot = layout.slots[shape.slot];
    const problems = [];
    if (!slot) problems.push("槽位越界");
    if (seenIds.has(shape.id)) problems.push("对象 ID 重复");
    if (seenSlots.has(shape.slot)) problems.push("槽位重复");
    seenIds.add(shape.id);
    seenSlots.add(shape.slot);

    const rect = shape.rect;
    if (slot && (rect.x !== slot.contentRect.x || rect.y !== slot.contentRect.y ||
      rect.w !== slot.contentRect.w || rect.h !== slot.contentRect.h)) {
      problems.push("采样矩形与网格不一致");
    }
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > canvas.width || rect.y + rect.h > canvas.height) {
      problems.push("采样矩形越出纹理");
    }

    let guardMax = 0;
    let alphaPixels = 0;
    if (slot) {
      for (let x = slot.x; x < slot.x + slot.w; x += 1) {
        for (const y of [slot.y, slot.y + slot.h - 1]) {
          guardMax = Math.max(guardMax, pixels[(y * canvas.width + x) * 4 + 3]);
        }
      }
      for (let y = slot.y; y < slot.y + slot.h; y += 1) {
        for (const x of [slot.x, slot.x + slot.w - 1]) {
          guardMax = Math.max(guardMax, pixels[(y * canvas.width + x) * 4 + 3]);
        }
      }
      for (let y = rect.y; y < rect.y + rect.h; y += 1) {
        for (let x = rect.x; x < rect.x + rect.w; x += 1) {
          if (pixels[(y * canvas.width + x) * 4 + 3] > 8) alphaPixels += 1;
        }
      }
    }
    if (guardMax > 0) problems.push(`隔离边 alpha=${guardMax}`);
    if (alphaPixels === 0) problems.push("采样区为空");

    const source = sourceById.get(shape.id);
    if (source && (
      source.kind !== shape.kind ||
      source.slot !== shape.slot ||
      Math.abs(source.scale - shape.transform.scale) > 1e-9 ||
      Math.abs(source.rotation - shape.transform.rotation) > 1e-9
    )) {
      problems.push("对象参数未完整恢复");
    }
    return {
      id: shape.id,
      name: shape.name,
      slot: shape.slot,
      grid: shape.grid,
      rect,
      alphaPixels,
      guardAlphaMax: guardMax,
      status: problems.length ? "fail" : "pass",
      problems,
    };
  });

  const textureHash = pixelHashFromCanvas(canvas);
  const structuralPass =
    canvas.width === index.atlas.width &&
    canvas.height === index.atlas.height &&
    items.length === index.shapeCount &&
    items.every((item) => item.status === "pass");
  return {
    passed: structuralPass && textureHash === index.texture.hash,
    textureHash,
    expectedTextureHash: index.texture.hash,
    objectCount: entries.length,
    expectedObjectCount: index.shapeCount,
    restoredCount: items.filter((item) => item.status === "pass").length,
    guardViolations: metrics.guardViolations,
    items,
    metrics,
  };
}

export function createBundle(index) {
  return {
    indexText: JSON.stringify(index, null, 2),
    indexHash: hashString(JSON.stringify(index)),
  };
}

export async function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG 编码失败"))), "image/png");
  });
}

export async function decodeAtlasBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = createCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function summarizeAtlas(canvas, index) {
  return {
    dimensions: `${canvas.width}x${canvas.height}`,
    textureHash: hashCanvas(canvas),
    exportedHash: index.texture.hash,
    objectCount: index.shapeCount,
    slotCount: index.atlas.capacity,
    edgePadding: index.atlas.edgePadding,
  };
}
