const DEFAULT_COMPACTION = {
  minUtilization: 0.36,
  dropTolerance: 0.14,
  targetUtilization: 0.62,
  minUpdates: 4,
};

export const DEFAULT_PACK_OPTIONS = Object.freeze({
  width: 512,
  height: 512,
  padding: 2,
  allowRotation: true,
  trim: true,
  autoGrow: true,
  autoCompact: true,
  maxWidth: 4096,
  maxHeight: 4096,
  compaction: DEFAULT_COMPACTION,
});

function normalizeOptions(options = {}) {
  const merged = {
    ...DEFAULT_PACK_OPTIONS,
    ...options,
    compaction: { ...DEFAULT_COMPACTION, ...(options.compaction ?? {}) },
  };
  for (const key of ["width", "height", "padding", "maxWidth", "maxHeight"]) {
    if (!Number.isInteger(merged[key]) || merged[key] < 0) {
      throw new RangeError(`${key} must be a non-negative integer`);
    }
  }
  if (merged.width < 1 || merged.height < 1) {
    throw new RangeError("Atlas dimensions must be at least 1x1");
  }
  return merged;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function subtractRect(freeRects, blocker) {
  const output = [];
  for (const free of freeRects) {
    if (!rectsOverlap(free, blocker)) {
      output.push(free);
      continue;
    }
    const freeRight = free.x + free.w;
    const freeBottom = free.y + free.h;
    const blockRight = blocker.x + blocker.w;
    const blockBottom = blocker.y + blocker.h;
    if (blocker.x > free.x) {
      output.push({ x: free.x, y: free.y, w: blocker.x - free.x, h: free.h });
    }
    if (blockRight < freeRight) {
      output.push({ x: blockRight, y: free.y, w: freeRight - blockRight, h: free.h });
    }
    const overlapLeft = Math.max(free.x, blocker.x);
    const overlapRight = Math.min(freeRight, blockRight);
    if (blocker.y > free.y && overlapRight > overlapLeft) {
      output.push({
        x: overlapLeft,
        y: free.y,
        w: overlapRight - overlapLeft,
        h: blocker.y - free.y,
      });
    }
    if (blockBottom < freeBottom && overlapRight > overlapLeft) {
      output.push({
        x: overlapLeft,
        y: blockBottom,
        w: overlapRight - overlapLeft,
        h: freeBottom - blockBottom,
      });
    }
  }
  return output;
}

function freeRectangles(width, height, placements) {
  let free = [{ x: 0, y: 0, w: width, h: height }];
  for (const placement of placements) {
    const blocker = {
      x: placement.allocX,
      y: placement.allocY,
      w: placement.slotW,
      h: placement.slotH,
    };
    free = subtractRect(free, blocker);
  }
  return free;
}

function findBestSlot(width, height, placements, slotWidth, slotHeight, old) {
  let best = null;
  const free = freeRectangles(width, height, placements);
  for (const area of free) {
    if (slotWidth > area.w || slotHeight > area.h) continue;
    const shortSide = Math.min(area.w - slotWidth, area.h - slotHeight);
    const longSide = Math.max(area.w - slotWidth, area.h - slotHeight);
    const waste = area.w * area.h - slotWidth * slotHeight;
    const oldDistance = old
      ? Math.abs(area.x - old.allocX) + Math.abs(area.y - old.allocY)
      : 0;
    const score = [shortSide, longSide, waste, old ? 0 : 1, oldDistance, area.y, area.x];
    if (!best || compareScores(score, best.score) < 0) {
      best = { x: area.x, y: area.y, score };
    }
  }
  return best;
}

function findScannedSlot(width, height, placements, slotWidth, slotHeight, old) {
  if (slotWidth > width || slotHeight > height) return null;
  const xs = new Set([0]);
  const ys = new Set([0]);
  const values = [...placements];
  for (const placement of values) {
    const right = placement.allocX + placement.slotW;
    const bottom = placement.allocY + placement.slotH;
    if (right + slotWidth <= width) xs.add(right);
    if (bottom + slotHeight <= height) ys.add(bottom);
  }
  const sortedX = [...xs].sort((left, right) => left - right);
  const sortedY = [...ys].sort((left, right) => left - right);
  let best = null;
  for (const y of sortedY) {
    for (const x of sortedX) {
      const candidate = { x, y, w: slotWidth, h: slotHeight };
      let blocked = false;
      for (const placement of values) {
        const occupied = {
          x: placement.allocX,
          y: placement.allocY,
          w: placement.slotW,
          h: placement.slotH,
        };
        if (rectsOverlap(candidate, occupied)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      const distance = old
        ? Math.abs(x - old.allocX) + Math.abs(y - old.allocY)
        : 0;
      const score = [0, 0, 0, old ? 0 : 1, distance, y, x];
      if (!best || compareScores(score, best.score) < 0) best = { x, y, score };
    }
  }
  return best;
}

function compareScores(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function trimBounds(frame) {
  const { width, height, pixels } = frame;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function prepareFrame(frame, options) {
  if (!frame || typeof frame.id !== "string" || frame.id.length === 0) {
    throw new TypeError("Every frame needs a non-empty string id");
  }
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height)) {
    throw new TypeError(`${frame.id}: width and height must be integers`);
  }
  if (frame.width < 1 || frame.height < 1) {
    throw new RangeError(`${frame.id}: frame dimensions must be positive`);
  }
  if (!(frame.pixels instanceof Uint8ClampedArray && frame.pixels.length === frame.width * frame.height * 4)) {
    throw new TypeError(`${frame.id}: RGBA pixel buffer does not match dimensions`);
  }
  const bounds = options.trim ? trimBounds(frame) : { x: 0, y: 0, w: frame.width, h: frame.height };
  if (!bounds) throw new Error(`${frame.id}: frame is fully transparent`);
  const orientations = [{ w: bounds.w, h: bounds.h, rotated: false }];
  if (options.allowRotation && bounds.w !== bounds.h) {
    orientations.push({ w: bounds.h, h: bounds.w, rotated: true });
  }
  const formats = orientations.map((orientation) => ({
    ...orientation,
    slotW: orientation.w + options.padding * 2,
    slotH: orientation.h + options.padding * 2,
  }));
  for (const format of formats) {
    if (format.slotW > options.maxWidth || format.slotH > options.maxHeight) {
      throw new RangeError(`${frame.id}: frame exceeds max atlas dimensions`);
    }
  }
  return {
    id: frame.id,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    trimRect: bounds,
    trimmed: bounds.w !== frame.width || bounds.h !== frame.height,
    colors: frame.colors ?? [],
    version: frame.version ?? 0,
    formats,
  };
}

function placementFrom(prepared, format, allocX, allocY, options) {
  return {
    id: prepared.id,
    x: allocX + options.padding,
    y: allocY + options.padding,
    w: format.w,
    h: format.h,
    rotated: format.rotated,
    allocX,
    allocY,
    slotW: format.slotW,
    slotH: format.slotH,
    sourceWidth: prepared.sourceWidth,
    sourceHeight: prepared.sourceHeight,
    trimRect: { ...prepared.trimRect },
    trimmed: prepared.trimmed,
    colors: [...prepared.colors],
    version: prepared.version,
  };
}

function placementsOverlap(left, right) {
  return (
    left.allocX < right.allocX + right.slotW &&
    right.allocX < left.allocX + left.slotW &&
    left.allocY < right.allocY + right.slotH &&
    right.allocY < left.allocY + left.slotH
  );
}

function roundUp(value, step = 16) {
  return Math.ceil(value / step) * step;
}

function formatFor(placement) {
  return {
    w: placement.w,
    h: placement.h,
    rotated: placement.rotated,
    slotW: placement.slotW,
    slotH: placement.slotH,
  };
}

function preparedFromPlacement(placement) {
  const formats = [formatFor(placement)];
  const normal = {
    w: placement.trimRect.w,
    h: placement.trimRect.h,
    rotated: false,
    slotW: placement.trimRect.w + (placement.slotW - placement.w),
    slotH: placement.trimRect.h + (placement.slotH - placement.h),
  };
  const rotated = {
    w: normal.h,
    h: normal.w,
    rotated: true,
    slotW: normal.slotH,
    slotH: normal.slotW,
  };
  const exists = formats.some((format) => format.rotated === normal.rotated);
  if (!exists) formats.push(normal);
  if (!formats.some((format) => format.rotated === rotated.rotated)) formats.push(rotated);
  return {
    id: placement.id,
    sourceWidth: placement.sourceWidth,
    sourceHeight: placement.sourceHeight,
    trimRect: { ...placement.trimRect },
    trimmed: placement.trimmed,
    colors: [...placement.colors],
    version: placement.version,
    formats,
  };
}

export class StableAtlasPacker {
  constructor(options = {}) {
    this.options = normalizeOptions(options);
    this.width = this.options.width;
    this.height = this.options.height;
    this.placements = new Map();
    this.prepared = new Map();
    this.smallUpdateCount = 0;
    this.bestUtilization = 0;
    this.lastChange = null;
  }

  _bestPlacement(prepared, placements, old = null) {
    let best = null;
    for (const format of prepared.formats) {
      const candidate =
        findBestSlot(
          this.width,
          this.height,
          placements.values(),
          format.slotW,
          format.slotH,
          old,
        ) ??
        findScannedSlot(
          this.width,
          this.height,
          placements.values(),
          format.slotW,
          format.slotH,
          old,
        );
      if (!candidate) continue;
      const score = [...candidate.score, format.rotated ? 1 : 0];
      if (!best || compareScores(score, best.score) < 0) {
        best = { ...candidate, format, score };
      }
    }
    return best;
  }

  _growAndPlace(prepared, placements) {
    if (!this.options.autoGrow) {
      throw new RangeError(`${prepared.id}: no free space at ${this.width}x${this.height}`);
    }
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const smallestSlotW = Math.min(...prepared.formats.map((format) => format.slotW));
      const smallestSlotH = Math.min(...prepared.formats.map((format) => format.slotH));
      if (smallestSlotW > this.width) {
        this.width = Math.max(this.width + 16, roundUp(smallestSlotW));
      } else if (smallestSlotH > this.height) {
        this.height = Math.max(this.height + 16, roundUp(smallestSlotH));
      } else if (this.width <= this.height) {
        this.width = roundUp(Math.max(this.width + 16, this.width * 1.2));
      } else {
        this.height = roundUp(Math.max(this.height + 16, this.height * 1.2));
      }
      if (this.width > this.options.maxWidth || this.height > this.options.maxHeight) {
        throw new RangeError(`${prepared.id}: atlas would exceed max dimensions`);
      }
      const found = this._bestPlacement(prepared, placements);
      if (found) {
        return placementFrom(prepared, found.format, found.x, found.y, this.options);
      }
    }
    throw new RangeError(`${prepared.id}: unable to place after atlas growth`);
  }

  _reuseSlot(prepared, old) {
    if (!old) return null;
    const ordered = [...prepared.formats].sort((left, right) => {
      if (left.rotated === old.rotated && right.rotated !== old.rotated) return -1;
      if (right.rotated === old.rotated && left.rotated !== old.rotated) return 1;
      return left.w * left.h - right.w * right.h;
    });
    const format = ordered.find(
      (candidate) => candidate.slotW <= old.slotW && candidate.slotH <= old.slotH,
    );
    return format ? placementFrom(prepared, format, old.allocX, old.allocY, this.options) : null;
  }

  _placePrepared(prepared, placements, old) {
    const reused = this._reuseSlot(prepared, old);
    if (reused) return reused;
    const found = this._bestPlacement(prepared, placements, old);
    if (found) return placementFrom(prepared, found.format, found.x, found.y, this.options);
    return this._growAndPlace(prepared, placements);
  }

  _packPreparedList(preparedList) {
    this.placements.clear();
    this.prepared.clear();
    const sorted = [...preparedList].sort((left, right) => {
      const leftSize = Math.max(...left.formats.map((format) => Math.max(format.slotW, format.slotH)));
      const rightSize = Math.max(...right.formats.map((format) => Math.max(format.slotW, format.slotH)));
      if (leftSize !== rightSize) return rightSize - leftSize;
      const leftArea = left.trimRect.w * left.trimRect.h;
      const rightArea = right.trimRect.w * right.trimRect.h;
      if (leftArea !== rightArea) return rightArea - leftArea;
      return left.id.localeCompare(right.id);
    });
    for (const prepared of sorted) {
      const placement = this._placePrepared(prepared, this.placements, null);
      this.placements.set(prepared.id, placement);
      this.prepared.set(prepared.id, prepared);
    }
  }

  packAll(frames) {
    const seen = new Set();
    const preparedList = [];
    for (const frame of frames) {
      const prepared = prepareFrame(frame, this.options);
      if (seen.has(prepared.id)) throw new Error(`Duplicate frame id: ${prepared.id}`);
      seen.add(prepared.id);
      preparedList.push(prepared);
    }
    this.width = this.options.width;
    this.height = this.options.height;
    this.smallUpdateCount = 0;
    this._packPreparedList(preparedList);
    this.bestUtilization = this.metrics().utilization;
    this.lastChange = null;
    return this.summary();
  }

  restorePlacements({ width, height, placements }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new RangeError("Restored atlas dimensions are invalid");
    }
    if (!Array.isArray(placements)) throw new TypeError("Restored placements must be an array");
    this.width = width;
    this.height = height;
    this.placements = new Map();
    this.prepared = new Map();
    for (const placement of placements) {
      if (!placement || typeof placement.id !== "string") throw new Error("Invalid restored placement");
      this.placements.set(placement.id, { ...placement, trimRect: { ...placement.trimRect } });
      this.prepared.set(placement.id, preparedFromPlacement(placement));
    }
    this.assertNoOverlaps();
    this.bestUtilization = this.metrics().utilization;
    return this.summary();
  }

  applyChanges(changes = {}) {
    const upserts = changes.upserts ?? [];
    const deletes = changes.deletes ?? [];
    if (!Array.isArray(upserts) || !Array.isArray(deletes)) {
      throw new TypeError("upserts and deletes must be arrays");
    }
    const deleteSet = new Set(deletes);
    if (deleteSet.size !== deletes.length) throw new Error("Duplicate ids in deletes");
    const seen = new Set();
    const preparedUpserts = upserts.map((frame) => {
      const prepared = prepareFrame(frame, this.options);
      if (deleteSet.has(prepared.id)) throw new Error(`${prepared.id}: cannot update and delete`);
      if (seen.has(prepared.id)) throw new Error(`Duplicate frame id in upserts: ${prepared.id}`);
      seen.add(prepared.id);
      return prepared;
    });

    const before = this.placements;
    const beforeWidth = this.width;
    const beforeHeight = this.height;
    const nextPlacements = new Map(before);
    const nextPrepared = new Map(this.prepared);
    try {
      for (const id of deletes) {
        nextPlacements.delete(id);
        nextPrepared.delete(id);
      }
      const pending = [];
      for (const prepared of preparedUpserts) {
        const old = before.get(prepared.id);
        const reused = this._reuseSlot(prepared, old);
        if (reused) {
          nextPlacements.set(prepared.id, reused);
          nextPrepared.set(prepared.id, prepared);
        } else {
          pending.push({ prepared, old });
        }
      }
      pending.sort((left, right) => {
        const leftArea = Math.max(
          ...left.prepared.formats.map((format) => format.slotW * format.slotH),
        );
        const rightArea = Math.max(
          ...right.prepared.formats.map((format) => format.slotW * format.slotH),
        );
        return rightArea - leftArea || left.prepared.id.localeCompare(right.prepared.id);
      });
      for (const { prepared, old } of pending) {
        const placement = this._placePrepared(prepared, nextPlacements, old);
        nextPlacements.set(prepared.id, placement);
        nextPrepared.set(prepared.id, prepared);
      }
      this.placements = nextPlacements;
      this.prepared = nextPrepared;
    } catch (error) {
      this.width = beforeWidth;
      this.height = beforeHeight;
      throw error;
    }

    const structural = this._changeReport(before, this.placements);
    const metrics = this.metrics();
    this.bestUtilization = Math.max(this.bestUtilization, metrics.utilization);
    this.smallUpdateCount += 1;
    let compacted = false;
    let compaction = null;
    const hardFloor = this.options.compaction.minUtilization * 0.85;
    const belowHardFloor =
      metrics.utilization < hardFloor &&
      this.bestUtilization - metrics.utilization > this.options.compaction.dropTolerance;
    const shouldCompact =
      this.options.autoCompact &&
      ((this.smallUpdateCount >= this.options.compaction.minUpdates &&
        metrics.utilization < this.options.compaction.minUtilization &&
        this.bestUtilization - metrics.utilization > this.options.compaction.dropTolerance) ||
        belowHardFloor);
    if (shouldCompact) {
      compaction = this.compact();
      compacted = compaction.compacted;
    }
    const finalReport = compacted ? this._changeReport(before, this.placements) : structural;
    const result = {
      ...finalReport,
      requested: {
        upsertIds: preparedUpserts.map((prepared) => prepared.id),
        deleteIds: [...deletes],
      },
      before: {
        width: beforeWidth,
        height: beforeHeight,
        utilization: areaUtilization(before, beforeWidth, beforeHeight),
      },
      after: {
        width: this.width,
        height: this.height,
        ...this.metrics(),
      },
      compacted,
      compaction,
    };
    this.lastChange = result;
    return result;
  }

  _changeReport(before, after) {
    const inserted = [];
    const deleted = [];
    const moved = [];
    const resized = [];
    const regionRects = [];
    for (const id of before.keys()) {
      if (!after.has(id)) {
        deleted.push(id);
        regionRects.push(actualRect(before.get(id)));
      }
    }
    for (const [id, placement] of after) {
      const old = before.get(id);
      if (!old) {
        inserted.push(id);
        regionRects.push(actualRect(placement));
        continue;
      }
      if (old.x !== placement.x || old.y !== placement.y || old.rotated !== placement.rotated) {
        moved.push(id);
        regionRects.push(actualRect(old), actualRect(placement));
      }
      if (old.w !== placement.w || old.h !== placement.h) resized.push(id);
    }
    for (const id of moved) {
      if (!resized.includes(id)) regionRects.push(actualRect(after.get(id)));
    }
    return {
      inserted,
      deleted,
      moved,
      resized,
      unchanged: after.size - inserted.length - moved.length,
      rearrangedRegion: unionRectangles(regionRects),
      changedIds: [...new Set([...inserted, ...moved, ...deleted])],
    };
  }

  compact() {
    const before = this.placements;
    const beforeWidth = this.width;
    const beforeHeight = this.height;
    const beforeMetrics = this.metrics();
    if (before.size === 0) {
      return { compacted: false, reason: "empty", before: beforeMetrics };
    }
    const target = this.options.compaction.targetUtilization;
    const scale = Math.sqrt(Math.min(1, beforeMetrics.utilization / Math.max(target, 0.01)));
    const scaledWidth = Math.max(64, Math.min(beforeWidth, roundUp(beforeWidth * scale)));
    const scaledHeight = Math.max(64, Math.min(beforeHeight, roundUp(beforeHeight * scale)));
    const candidates = uniqueDimensions([
      [scaledWidth, scaledHeight],
      [scaledWidth, beforeHeight],
      [beforeWidth, scaledHeight],
    ]);
    const preparedList = [...before.values()].map(preparedFromPlacement);
    let best = null;
    for (const [width, height] of candidates) {
      try {
        const temporary = new StableAtlasPacker({
          ...this.options,
          width,
          height,
          autoGrow: true,
          autoCompact: false,
          maxWidth: beforeWidth,
          maxHeight: beforeHeight,
        });
        temporary._packPreparedList(preparedList);
        const metrics = temporary.metrics();
        if (
          !best ||
          metrics.utilization > best.metrics.utilization + 0.0001 ||
          (Math.abs(metrics.utilization - best.metrics.utilization) < 0.0001 &&
            temporary.width * temporary.height < best.width * best.height)
        ) {
          best = {
            width: temporary.width,
            height: temporary.height,
            placements: temporary.placements,
            prepared: temporary.prepared,
            metrics,
          };
        }
      } catch {
        // A target that is too small is expected; keep trying larger candidates.
      }
    }
    if (
      !best ||
      best.metrics.utilization <= beforeMetrics.utilization + 0.01 ||
      best.width * best.height >= beforeWidth * beforeHeight
    ) {
      return {
        compacted: false,
        reason: "no-improvement",
        before: beforeMetrics,
        candidates: candidates.length,
      };
    }
    this.width = best.width;
    this.height = best.height;
    this.placements = best.placements;
    this.prepared = best.prepared;
    this.bestUtilization = Math.max(this.bestUtilization, best.metrics.utilization);
    this.smallUpdateCount = 0;
    return {
      compacted: true,
      reason: "utilization-guard",
      before: beforeMetrics,
      after: this.metrics(),
      candidateCount: candidates.length,
    };
  }

  metrics() {
    return {
      ...this.metricsFor(this.placements, this.width, this.height),
      frameCount: this.placements.size,
      width: this.width,
      height: this.height,
    };
  }

  metricsFor(placements, width, height) {
    let usedArea = 0;
    let slotArea = 0;
    const rects = [];
    for (const placement of placements.values()) {
      usedArea += placement.w * placement.h;
      slotArea += placement.slotW * placement.slotH;
      rects.push(actualRect(placement));
    }
    return {
      usedArea,
      slotArea,
      utilization: usedArea / (width * height),
      bounds: unionRectangles(rects),
    };
  }

  assertNoOverlaps() {
    const values = [...this.placements.values()];
    for (let left = 0; left < values.length; left += 1) {
      const a = values[left];
      if (
        a.allocX < 0 ||
        a.allocY < 0 ||
        a.allocX + a.slotW > this.width ||
        a.allocY + a.slotH > this.height
      ) {
        throw new Error(`${a.id}: placement is outside atlas bounds`);
      }
      for (let right = left + 1; right < values.length; right += 1) {
        if (placementsOverlap(a, values[right])) {
          throw new Error(`${a.id}: overlaps ${values[right].id}`);
        }
      }
    }
    return true;
  }

  summary() {
    return {
      width: this.width,
      height: this.height,
      options: this.options,
      metrics: this.metrics(),
      placements: [...this.placements.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((placement) => ({ ...placement, trimRect: { ...placement.trimRect } })),
    };
  }
}

function actualRect(placement) {
  return { x: placement.x, y: placement.y, w: placement.w, h: placement.h };
}

function unionRectangles(rects) {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function areaUtilization(placements, width, height) {
  let area = 0;
  for (const placement of placements.values()) area += placement.w * placement.h;
  return area / (width * height);
}

function uniqueDimensions(dimensions) {
  const seen = new Set();
  return dimensions.filter(([width, height]) => {
    const key = `${width}x${height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
