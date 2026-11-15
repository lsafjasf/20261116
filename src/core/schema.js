import { cloneProject, projectFingerprint, stableStringify } from "./project.js";
import { hashPixels } from "./sprite.js";
import { StableAtlasPacker } from "./packer.js";

export const ATLAS_FORMAT = "stable-sprite-atlas";
export const SNAPSHOT_FORMAT = "stable-sprite-atlas-snapshot";

function sliceFromPlacement(placement) {
  return {
    id: placement.id,
    frame: {
      x: placement.x,
      y: placement.y,
      w: placement.w,
      h: placement.h,
    },
    rotated: placement.rotated,
    trimmed: placement.trimmed,
    sourceSize: {
      w: placement.sourceWidth,
      h: placement.sourceHeight,
    },
    spriteSourceSize: {
      x: placement.trimRect.x,
      y: placement.trimRect.y,
      w: placement.trimRect.w,
      h: placement.trimRect.h,
    },
    colors: [...placement.colors],
  };
}

export function buildAtlasPackage({
  packer,
  project,
  atlas,
  imageDataUrl = null,
  exportedAt = new Date().toISOString(),
  snapshot = null,
  checks = {},
}) {
  if (!packer || !project || !atlas) throw new Error("Packer, project and atlas are required");
  if (atlas.width !== packer.width || atlas.height !== packer.height) {
    throw new Error("Atlas pixels do not match packer dimensions");
  }
  const orderedIds = project.frameOrder.filter((id) => packer.placements.has(id));
  const slices = orderedIds.map((id) => sliceFromPlacement(packer.placements.get(id)));
  for (const id of packer.placements.keys()) {
    if (!orderedIds.includes(id)) slices.push(sliceFromPlacement(packer.placements.get(id)));
  }
  const pixelHash = hashPixels(atlas.pixels);
  const stateFingerprint = projectFingerprint(cloneProject(project), packer);
  return {
    format: ATLAS_FORMAT,
    version: 1,
    exportedAt,
    atlas: {
      width: packer.width,
      height: packer.height,
      image: "atlas.png",
      pixelHash,
      imageDataUrl,
      ...checks.atlas,
    },
    meta: {
      generator: "stable-sprite-atlas-lab",
      frameCount: slices.length,
      utilization: packer.metrics().utilization,
      parameters: packer.options,
      ...checks.meta,
    },
    project: cloneProject(project),
    frames: slices,
    fingerprint: stateFingerprint,
    snapshot,
  };
}

export function validateAtlasPackage(pkg) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (!pkg || typeof pkg !== "object") return { ok: false, errors: ["JSON 根节点不是对象"] };
  if (pkg.format !== ATLAS_FORMAT && pkg.format !== SNAPSHOT_FORMAT) fail("未知的 format");
  if (pkg.version !== 1) fail("不支持的 version");
  if (!pkg.atlas || !Number.isInteger(pkg.atlas.width) || !Number.isInteger(pkg.atlas.height)) {
    fail("atlas 宽高无效");
  }
  if (!Array.isArray(pkg.frames) || pkg.frames.length === 0) fail("frames 不能为空");
  if (!pkg.project || !Array.isArray(pkg.project.layers) || !Array.isArray(pkg.project.keyframes)) {
    fail("project 图层或关键帧缺失");
  }
  if (errors.length > 0) return { ok: false, errors };

  const ids = new Set();
  const rects = [];
  for (const slice of pkg.frames) {
    if (!slice || typeof slice.id !== "string") {
      fail("存在无 id 的切片");
      continue;
    }
    if (ids.has(slice.id)) fail(`${slice.id}: 重复切片`);
    ids.add(slice.id);
    const rect = slice.frame;
    const source = slice.sourceSize;
    const trim = slice.spriteSourceSize;
    if (![rect?.x, rect?.y, rect?.w, rect?.h].every(Number.isInteger)) {
      fail(`${slice.id}: frame 坐标或尺寸无效`);
      continue;
    }
    if (rect.w < 1 || rect.h < 1) fail(`${slice.id}: frame 尺寸必须为正`);
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > pkg.atlas.width || rect.y + rect.h > pkg.atlas.height) {
      fail(`${slice.id}: frame 超出图集`);
    }
    if (!source || source.w < 1 || source.h < 1) fail(`${slice.id}: sourceSize 无效`);
    if (!trim || [trim.x, trim.y, trim.w, trim.h].some((value) => !Number.isInteger(value))) {
      fail(`${slice.id}: spriteSourceSize 无效`);
    } else if (
      trim.x < 0 ||
      trim.y < 0 ||
      trim.w < 1 ||
      trim.h < 1 ||
      trim.x + trim.w > source.w ||
      trim.y + trim.h > source.h
    ) {
      fail(`${slice.id}: 裁边区域超出原尺寸`);
    }
    const expected = slice.rotated ? [trim.h, trim.w] : [trim.w, trim.h];
    if (rect.w !== expected[0] || rect.h !== expected[1]) {
      fail(`${slice.id}: rotated 与 frame 尺寸不一致`);
    }
    if (!Array.isArray(slice.colors) || slice.colors.some((color) => typeof color !== "string")) {
      fail(`${slice.id}: 颜色元数据缺失`);
    }
    rects.push(rect);
  }
  for (let left = 0; left < rects.length; left += 1) {
    for (let right = left + 1; right < rects.length; right += 1) {
      if (
        rects[left].x < rects[right].x + rects[right].w &&
        rects[right].x < rects[left].x + rects[left].w &&
        rects[left].y < rects[right].y + rects[right].h &&
        rects[right].y < rects[left].y + rects[left].h
      ) {
        fail(`切片 ${left} 与 ${right} 重叠`);
      }
    }
  }
  const layerIds = new Set();
  for (const layer of pkg.project.layers) {
    if (layerIds.has(layer.id)) fail(`${layer.id}: 图层 id 重复`);
    layerIds.add(layer.id);
    if (typeof layer.color !== "string") fail(`${layer.id}: 图层颜色缺失`);
  }
  for (const keyframe of pkg.project.keyframes) {
    if (!Number.isInteger(keyframe.index)) fail(`${keyframe.id}: 关键帧序号无效`);
    if (!ids.has(keyframe.frameId)) fail(`${keyframe.id}: 引用的帧不存在`);
    if (!keyframe.colors || Object.values(keyframe.colors).some((color) => typeof color !== "string")) {
      fail(`${keyframe.id}: 关键帧颜色缺失`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function packageFingerprint(pkg) {
  return stableStringify({
    atlas: { width: pkg.atlas.width, height: pkg.atlas.height, pixelHash: pkg.atlas.pixelHash },
    project: pkg.project,
    frames: pkg.frames.map((slice) => ({
      id: slice.id,
      frame: slice.frame,
      rotated: slice.rotated,
      trimmed: slice.trimmed,
      sourceSize: slice.sourceSize,
      spriteSourceSize: slice.spriteSourceSize,
      colors: slice.colors,
    })),
  });
}

export function packerFromPackage(pkg) {
  const validation = validateAtlasPackage(pkg);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const parameters = pkg.meta?.parameters ?? {};
  const padding = parameters.padding ?? 0;
  const packer = new StableAtlasPacker({
    ...parameters,
    width: pkg.atlas.width,
    height: pkg.atlas.height,
    autoGrow: false,
    autoCompact: false,
  });
  const placements = pkg.frames.map((slice) => ({
    id: slice.id,
    x: slice.frame.x,
    y: slice.frame.y,
    w: slice.frame.w,
    h: slice.frame.h,
    rotated: Boolean(slice.rotated),
    allocX: slice.frame.x - padding,
    allocY: slice.frame.y - padding,
    slotW: slice.frame.w + padding * 2,
    slotH: slice.frame.h + padding * 2,
    sourceWidth: slice.sourceSize.w,
    sourceHeight: slice.sourceSize.h,
    trimRect: {
      x: slice.spriteSourceSize.x,
      y: slice.spriteSourceSize.y,
      w: slice.spriteSourceSize.w,
      h: slice.spriteSourceSize.h,
    },
    trimmed: Boolean(slice.trimmed),
    colors: [...slice.colors],
    version: 0,
  }));
  packer.restorePlacements({
    width: pkg.atlas.width,
    height: pkg.atlas.height,
    placements,
  });
  return packer;
}

export function createSnapshotPackage(args) {
  const pkg = buildAtlasPackage({ ...args, exportedAt: args.capturedAt ?? new Date().toISOString() });
  return {
    ...pkg,
    format: SNAPSHOT_FORMAT,
    snapshot: {
      id: args.snapshotId ?? `snapshot-${Date.now()}`,
      label: args.label ?? "pre-export",
      capturedAt: args.capturedAt ?? new Date().toISOString(),
      beforeExport: true,
      packageFingerprint: packageFingerprint(pkg),
    },
  };
}
