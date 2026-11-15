const ROOT_DEFAULT_STYLE = {
  fontFamily: '"Noto Sans SC", "Avenir Next", "PingFang SC", sans-serif',
  fontSize: 16,
  fontWeight: 500,
  color: "#20251f",
};

const LAYOUT_PROPS = new Set([
  "x",
  "y",
  "width",
  "height",
  "right",
  "bottom",
  "rotation",
  "clip",
  "fontSize",
  "fontFamily",
  "fontWeight",
  "text",
  "lineHeight",
  "letterSpacing",
  "align",
]);

const FONT_PROPS = new Set(["fontSize", "fontFamily", "fontWeight"]);

export function fnv1a(value) {
  const input = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function resolvePercent(value, base) {
  if (typeof value === "string" && value.trim().endsWith("%")) {
    return (Number.parseFloat(value) / 100) * base;
  }
  return Number(value);
}

function resolvePosition(value, base) {
  if (value === null || value === undefined) return 0;
  return resolvePercent(value, base);
}

function resolveSize(value, base, fallback) {
  if (value === null || value === undefined) return Math.max(0, fallback);
  return Math.max(0, resolvePercent(value, base));
}

function defaultMeasureText(text, style) {
  let width = 0;
  for (const char of String(text)) {
    if (/\s/.test(char)) width += style.fontSize * 0.28;
    else if (/[\u3000-\u9fff]/u.test(char)) width += style.fontSize;
    else width += style.fontSize * 0.56;
  }
  return width;
}

function makeNode(id, parentId, props) {
  return {
    id,
    name: props.name ?? "未命名图层",
    type: props.type ?? "group",
    parentId,
    children: [],
    x: props.x ?? null,
    y: props.y ?? null,
    width: props.width ?? null,
    height: props.height ?? null,
    right: props.right ?? null,
    bottom: props.bottom ?? null,
    rotation: props.rotation ?? 0,
    clip: Boolean(props.clip),
    visible: props.visible !== false,
    opacity: props.opacity ?? 1,
    fill: props.fill ?? null,
    stroke: props.stroke ?? null,
    strokeWidth: props.strokeWidth ?? 1,
    radius: props.radius ?? 0,
    text: props.text ?? "",
    fontFamily: props.fontFamily ?? null,
    fontSize: props.fontSize ?? null,
    fontWeight: props.fontWeight ?? null,
    color: props.color ?? null,
    lineHeight: props.lineHeight ?? 1.08,
    letterSpacing: props.letterSpacing ?? 0,
    align: props.align ?? "left",
    shadow: props.shadow ?? null,
    cache: {
      layout: null,
      paint: null,
      layoutDirty: true,
      paintDirty: true,
    },
  };
}

export class SceneEngine {
  constructor({ measureText = defaultMeasureText, invalidation = "fine", name = "scene" } = {}) {
    this.name = name;
    this.measureText = measureText;
    this.invalidation = invalidation;
    this.nodes = new Map();
    this.rootId = null;
    this.revision = 0;
    this.stats = this.emptyStats();
    this.lastUpdate = this.emptyUpdate();
    this.lastInvalidation = this.emptyInvalidation();
    this.lastDeletion = null;
    this.recomputeLog = [];
  }

  emptyStats() {
    return {
      layoutHits: 0,
      layoutMisses: 0,
      paintHits: 0,
      paintMisses: 0,
      layoutRecomputes: 0,
      paintRecomputes: 0,
      frames: 0,
      frameMs: 0,
      lastFrameMs: 0,
    };
  }

  emptyUpdate() {
    return {
      visited: new Set(),
      layoutVisited: new Set(),
      paintVisited: new Set(),
      layoutHits: 0,
      layoutMisses: 0,
      paintHits: 0,
      paintMisses: 0,
      layoutRecomputes: 0,
      paintRecomputes: 0,
      keyRecoveries: 0,
    };
  }

  emptyInvalidation() {
    return {
      reason: null,
      ids: [],
      layoutIds: [],
      paintIds: [],
      candidateCount: 0,
      layoutCandidates: 0,
      paintCandidates: 0,
      recoveryCount: 0,
      deletedCount: 0,
    };
  }

  add(parentId, props = {}) {
    if (parentId === null && this.rootId) {
      throw new Error("Scene already has a root node");
    }
    const parent = parentId === null ? null : this.requireNode(parentId);
    const baseId = props.id ?? `${props.type ?? "node"}-${this.nodes.size + 1}`;
    let id = baseId;
    let suffix = 2;
    while (this.nodes.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const node = makeNode(id, parentId, props);
    this.nodes.set(id, node);
    if (parent) parent.children.push(id);
    else this.rootId = id;
    this.invalidateNode(id, "add");
    return node;
  }

  requireNode(id) {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown node: ${id}`);
    return node;
  }

  getNode(id) {
    return this.nodes.get(id) ?? null;
  }

  getParent(node) {
    return node.parentId ? this.nodes.get(node.parentId) ?? null : null;
  }

  resolveStyle(node) {
    const parent = this.getParent(node);
    const inherited = parent
      ? parent._resolvedStyle ?? this.resolveStyle(parent)
      : { ...ROOT_DEFAULT_STYLE, key: fnv1a(stableStringify(ROOT_DEFAULT_STYLE)) };
    const own = {
      fontFamily: node.fontFamily ?? inherited.fontFamily,
      fontSize: node.fontSize ?? inherited.fontSize,
      fontWeight: node.fontWeight ?? inherited.fontWeight,
      color: node.color ?? inherited.color,
    };
    const key = fnv1a(
      stableStringify({
        parent: parent ? inherited.key : null,
        own: {
          fontFamily: node.fontFamily,
          fontSize: node.fontSize,
          fontWeight: node.fontWeight,
          color: node.color,
        },
        effective: own,
      }),
    );
    const style = { ...own, key };
    node._resolvedStyle = style;
    return style;
  }

  getFontSource(node, property = "fontSize") {
    let cursor = node;
    while (cursor) {
      if (cursor[property] !== null && cursor[property] !== undefined) return cursor;
      cursor = this.getParent(cursor);
    }
    return null;
  }

  getFontDependents(id, properties = [...FONT_PROPS]) {
    const source = this.requireNode(id);
    const affected = [];
    const walk = (node) => {
      if (properties.some((property) => this.getFontSource(node, property) === source)) {
        affected.push(node.id);
      }
      for (const childId of node.children) walk(this.requireNode(childId));
    };
    walk(source);
    return affected;
  }

  fontString(style) {
    return `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
  }

  wrapText(text, maxWidth, style) {
    if (!text) return [];
    const lines = [];
    for (const paragraph of String(text).split("\n")) {
      if (paragraph === "") {
        lines.push("");
        continue;
      }
      const paragraphTokens = paragraph.match(/\s+|[A-Za-z0-9%+.,:/-]+|./gu) ?? [];
      let line = "";
      for (const token of paragraphTokens) {
        const next = line + token;
        if (line && this.measureText(next, style) > maxWidth + 0.25) {
          lines.push(line.trimEnd());
          line = token.trimStart();
        } else {
          line = next;
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  }

  ensureLayout(node) {
    const update = this.lastUpdate;
    if (update.layoutVisited.has(node.id)) return node.cache.layout;
    update.layoutVisited.add(node.id);
    update.visited.add(node.id);
    const parent = this.getParent(node);
    const parentLayout = parent ? this.ensureLayout(parent) : null;
    const parentWidth = parentLayout?.width ?? 0;
    const parentHeight = parentLayout?.height ?? 0;
    const explicitWidth = node.width === null ? null : resolveSize(node.width, parentWidth, 0);
    const explicitHeight = node.height === null ? null : resolveSize(node.height, parentHeight, 0);
    const x = node.x === null
      ? node.right !== null && explicitWidth !== null
        ? parentWidth - Number(node.right) - explicitWidth
        : 0
      : resolvePosition(node.x, parentWidth);
    const y = node.y === null
      ? node.bottom !== null && explicitHeight !== null
        ? parentHeight - Number(node.bottom) - explicitHeight
        : 0
      : resolvePosition(node.y, parentHeight);
    const width = explicitWidth ?? resolveSize(
      null,
      parentWidth,
      node.right === null ? parentWidth - x : parentWidth - x - Number(node.right),
    );
    const height = explicitHeight ?? resolveSize(
      null,
      parentHeight,
      node.bottom === null ? parentHeight - y : parentHeight - y - Number(node.bottom),
    );
    const style = this.resolveStyle(node);
    const keyInput = {
      version: 2,
      id: node.id,
      type: node.type,
      x,
      y,
      width,
      height,
      rotation: node.rotation,
      clip: node.clip,
      parentKey: parentLayout?.key ?? "root",
      styleKey: style.key,
      text: node.type === "text" ? node.text : null,
      lineHeight: node.lineHeight,
      letterSpacing: node.letterSpacing,
      align: node.align,
    };
    const key = fnv1a(stableStringify(keyInput));
    const cached = node.cache.layout;
    if (!node.cache.layoutDirty && cached && cached.key === key) {
      update.layoutHits += 1;
      this.stats.layoutHits += 1;
      return cached;
    }
    if (!node.cache.layoutDirty && cached && cached.key !== key) {
      update.keyRecoveries += 1;
    }
    update.layoutMisses += 1;
    update.layoutRecomputes += 1;
    this.stats.layoutMisses += 1;
    this.stats.layoutRecomputes += 1;
    const worldX = (parentLayout?.worldX ?? 0) + x;
    const worldY = (parentLayout?.worldY ?? 0) + y;
    const layout = {
      key,
      styleKey: style.key,
      x,
      y,
      width,
      height,
      worldX,
      worldY,
      rotation: node.rotation,
      textLines: node.type === "text" ? this.wrapText(node.text, width, style) : [],
    };
    node.cache.layout = layout;
    node.cache.layoutDirty = false;
    if (this.recomputeLog.length > 160) this.recomputeLog.shift();
    this.recomputeLog.push({
      revision: this.revision,
      nodeId: node.id,
      kind: "layout",
      key,
      reason: this.lastInvalidation.reason,
    });
    return layout;
  }

  ownPaintCommand(node, layout, style) {
    const common = {
      x: layout.worldX,
      y: layout.worldY,
      w: layout.width,
      h: layout.height,
    };
    if (node.type === "text") {
      return [{
        kind: "text",
        ...common,
        lines: layout.textLines,
        font: this.fontString(style),
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        letterSpacing: node.letterSpacing,
        lineHeight: node.lineHeight,
        color: style.color,
        align: node.align,
      }];
    }
    if (node.type === "line") {
      return [{
        kind: "line",
        x1: layout.worldX,
        y1: layout.worldY,
        x2: layout.worldX + layout.width,
        y2: layout.worldY + layout.height,
        color: node.stroke ?? style.color,
        width: node.strokeWidth,
      }];
    }
    if (node.type === "ellipse") {
      return [{
        kind: "ellipse",
        ...common,
        fill: node.fill,
        stroke: node.stroke,
        strokeWidth: node.strokeWidth,
        shadow: node.shadow,
      }];
    }
    if (node.type === "rect" || node.fill || node.stroke) {
      return [{
        kind: "rect",
        ...common,
        radius: Math.min(node.radius, layout.width / 2, layout.height / 2),
        fill: node.fill,
        stroke: node.stroke,
        strokeWidth: node.strokeWidth,
        shadow: node.shadow,
      }];
    }
    return [];
  }

  ensurePaint(node, parentVisible = true) {
    const update = this.lastUpdate;
    if (update.paintVisited.has(node.id)) return node.cache.paint;
    update.paintVisited.add(node.id);
    update.visited.add(node.id);
    const layout = this.ensureLayout(node);
    const style = this.resolveStyle(node);
    const effectiveVisible = parentVisible && node.visible;
    const childPaints = [];
    if (effectiveVisible) {
      for (const childId of node.children) {
        childPaints.push(this.ensurePaint(this.requireNode(childId), true));
      }
    }
    const keyInput = {
      version: 2,
      layoutKey: layout.key,
      visible: effectiveVisible,
      opacity: node.opacity,
      rotation: node.rotation,
      clip: node.clip,
      type: node.type,
      fill: node.fill,
      stroke: node.stroke,
      strokeWidth: node.strokeWidth,
      radius: node.radius,
      shadow: node.shadow,
      styleKey: style.key,
      textLines: layout.textLines,
      align: node.align,
      children: childPaints.map((paint) => paint?.key ?? "none"),
    };
    const key = fnv1a(stableStringify(keyInput));
    const cached = node.cache.paint;
    if (!node.cache.paintDirty && cached && cached.key === key) {
      update.paintHits += 1;
      this.stats.paintHits += 1;
      return cached;
    }
    if (!node.cache.paintDirty && cached && cached.key !== key) {
      update.keyRecoveries += 1;
    }
    update.paintMisses += 1;
    update.paintRecomputes += 1;
    this.stats.paintMisses += 1;
    this.stats.paintRecomputes += 1;
    let paint;
    if (!effectiveVisible) {
      paint = { key, commands: [] };
    } else {
      const commands = [
        ...this.ownPaintCommand(node, layout, style),
        ...childPaints.flatMap((child) => child.commands),
      ];
      paint = {
        key,
        commands: [{
          kind: "group",
          opacity: node.opacity,
          rotation: node.rotation,
          centerX: layout.worldX + layout.width / 2,
          centerY: layout.worldY + layout.height / 2,
          clip: node.clip
            ? {
              x: layout.worldX,
              y: layout.worldY,
              w: layout.width,
              h: layout.height,
              radius: Math.min(node.radius, layout.width / 2, layout.height / 2),
            }
            : null,
          commands,
        }],
      };
    }
    node.cache.paint = paint;
    node.cache.paintDirty = false;
    if (this.recomputeLog.length > 160) this.recomputeLog.shift();
    this.recomputeLog.push({
      revision: this.revision,
      nodeId: node.id,
      kind: "paint",
      key,
      reason: this.lastInvalidation.reason,
    });
    return paint;
  }

  render() {
    if (!this.rootId) return [];
    this.lastUpdate = this.emptyUpdate();
    const root = this.requireNode(this.rootId);
    const paint = this.ensurePaint(root, true);
    this.stats.frames += 1;
    return paint.commands;
  }

  getCacheEntries() {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (node.cache.layout) count += 1;
      if (node.cache.paint) count += 1;
    }
    return count;
  }

  getMetrics() {
    const hits = this.stats.layoutHits + this.stats.paintHits;
    const misses = this.stats.layoutMisses + this.stats.paintMisses;
    const hitRate = hits + misses ? hits / (hits + misses) : 0;
    const updateHits = this.lastUpdate.layoutHits + this.lastUpdate.paintHits;
    const updateMisses = this.lastUpdate.layoutMisses + this.lastUpdate.paintMisses;
    const updateHitRate = updateHits + updateMisses ? updateHits / (updateHits + updateMisses) : 0;
    return {
      ...this.stats,
      hitRate,
      updateHitRate,
      updateHits,
      updateMisses,
      candidateCount: this.lastInvalidation.candidateCount,
      layoutCandidates: this.lastInvalidation.layoutCandidates,
      paintCandidates: this.lastInvalidation.paintCandidates,
      deletedCount: this.lastInvalidation.deletedCount,
      nodeCount: this.nodes.size,
      cacheEntries: this.getCacheEntries(),
      visitedCount: this.lastUpdate.visited.size,
      danglingCount: this.validateInvariants().length,
    };
  }

  resetStats() {
    this.stats = this.emptyStats();
    this.lastUpdate = this.emptyUpdate();
  }

  resetTelemetry() {
    this.resetStats();
    this.lastInvalidation = this.emptyInvalidation();
    this.recomputeLog = [];
  }

  collectSubtree(id, output = new Set()) {
    const node = this.nodes.get(id);
    if (!node || output.has(id)) return output;
    output.add(id);
    for (const childId of node.children) this.collectSubtree(childId, output);
    return output;
  }

  markAncestorsForPaint(id, paintIds) {
    let cursor = this.nodes.get(id);
    cursor = cursor ? this.getParent(cursor) : null;
    while (cursor) {
      paintIds.add(cursor.id);
      cursor = this.getParent(cursor);
    }
  }

  applyInvalidation(layoutIds, paintIds, reason, extra = {}) {
    const layoutSet = new Set(layoutIds);
    const paintSet = new Set(paintIds ?? []);
    for (const id of layoutSet) paintSet.add(id);
    for (const id of layoutSet) this.markAncestorsForPaint(id, paintSet);
    for (const id of paintSet) this.markAncestorsForPaint(id, paintSet);
    for (const id of layoutSet) {
      const node = this.nodes.get(id);
      if (!node) continue;
      node.cache.layoutDirty = true;
      node.cache.paintDirty = true;
    }
    for (const id of paintSet) {
      const node = this.nodes.get(id);
      if (node) node.cache.paintDirty = true;
    }
    const ids = new Set([...layoutSet, ...paintSet]);
    const validIds = [...ids].filter((id) => this.nodes.has(id)).sort();
    this.lastInvalidation = {
      reason,
      ids: validIds,
      layoutIds: [...layoutSet].filter((id) => this.nodes.has(id)).sort(),
      paintIds: [...paintSet].filter((id) => this.nodes.has(id)).sort(),
      candidateCount: validIds.length,
      layoutCandidates: layoutSet.size,
      paintCandidates: paintSet.size,
      recoveryCount: 0,
      deletedCount: extra.deletedCount ?? 0,
    };
  }

  invalidateNode(id, reason = "update") {
    if (this.invalidation === "full") {
      this.invalidateAll(reason);
      return;
    }
    const subtree = this.collectSubtree(id);
    const paintIds = new Set(subtree);
    for (const nodeId of subtree) this.markAncestorsForPaint(nodeId, paintIds);
    this.applyInvalidation(subtree, paintIds, reason);
  }

  invalidateAll(reason = "full") {
    const ids = new Set(this.nodes.keys());
    this.applyInvalidation(ids, new Set(ids), reason);
  }

  updateNode(id, patch, reason = "property") {
    const node = this.requireNode(id);
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.revision += 1;
    const affectsFont = keys.some((key) => FONT_PROPS.has(key));
    const affectedFontProperties = keys.filter((key) => FONT_PROPS.has(key));
    const affectsLayout = keys.some((key) => LAYOUT_PROPS.has(key));
    const affectsVisibility = keys.includes("visible");
    const affectsPaint = keys.some((key) => !["name", "id", "type", "parentId"].includes(key));
    const fontTargetsBefore = affectsFont
      ? new Set(this.getFontDependents(id, affectedFontProperties))
      : new Set();
    Object.assign(node, patch);
    const fontTargetsAfter = affectsFont
      ? new Set(this.getFontDependents(id, affectedFontProperties))
      : new Set();
    node._resolvedStyle = null;
    if (this.invalidation === "full") {
      this.invalidateAll(reason);
      return;
    }
    const layoutTargets = new Set();
    const paintTargets = new Set();
    if (affectsFont) {
      for (const target of [...fontTargetsBefore, ...fontTargetsAfter, id]) {
        layoutTargets.add(target);
        paintTargets.add(target);
        this.markAncestorsForPaint(target, paintTargets);
      }
    }
    if (affectsLayout) {
      const subtree = this.collectSubtree(id);
      for (const target of subtree) {
        layoutTargets.add(target);
        paintTargets.add(target);
      }
      this.markAncestorsForPaint(id, paintTargets);
    }
    if (affectsVisibility) {
      for (const target of this.collectSubtree(id)) paintTargets.add(target);
      this.markAncestorsForPaint(id, paintTargets);
    }
    if (affectsPaint && !affectsLayout && !affectsFont && !affectsVisibility) {
      paintTargets.add(id);
      this.markAncestorsForPaint(id, paintTargets);
    }
    this.applyInvalidation(layoutTargets, paintTargets, reason);
  }

  setVisible(id, visible) {
    this.updateNode(id, { visible: Boolean(visible) }, "visibility");
  }

  setFontSize(id, fontSize) {
    this.updateNode(id, { fontSize }, "font");
  }

  deleteNode(id) {
    const node = this.requireNode(id);
    if (id === this.rootId) throw new Error("Cannot delete the root node");
    const deleted = this.collectSubtree(id);
    const parent = this.getParent(node);
    if (parent) parent.children = parent.children.filter((childId) => childId !== id);
    this.revision += 1;
    for (const nodeId of deleted) {
      const target = this.nodes.get(nodeId);
      if (target) {
        target.cache.layout = null;
        target.cache.paint = null;
        target.children = [];
      }
      this.nodes.delete(nodeId);
    }
    if (this.invalidation === "full") {
      const remainingIds = new Set(this.nodes.keys());
      this.applyInvalidation(remainingIds, new Set(remainingIds), "delete", {
        deletedCount: deleted.size,
      });
    } else {
      const paintIds = new Set();
      if (parent) {
        paintIds.add(parent.id);
        this.markAncestorsForPaint(parent.id, paintIds);
      }
      this.applyInvalidation(new Set(), paintIds, "delete", { deletedCount: deleted.size });
    }
    const danglingCount = this.validateInvariants().length;
    this.lastDeletion = {
      deletedCount: deleted.size,
      danglingCount,
      remainingNodes: this.nodes.size,
    };
    return this.lastDeletion;
  }

  validateInvariants() {
    const issues = [];
    if (!this.rootId) return ["missing root"];
    if (!this.nodes.has(this.rootId)) issues.push(`root ${this.rootId} is missing`);
    const reachable = new Set();
    const walk = (id, parentId = null) => {
      if (!this.nodes.has(id)) {
        issues.push(`missing node ${id}`);
        return;
      }
      if (reachable.has(id)) issues.push(`cycle or duplicate ${id}`);
      reachable.add(id);
      const node = this.nodes.get(id);
      if (node.parentId !== parentId) {
        issues.push(`parent mismatch ${id}: ${node.parentId} != ${parentId}`);
      }
      for (const childId of node.children) walk(childId, id);
    };
    walk(this.rootId);
    for (const id of this.nodes.keys()) {
      if (!reachable.has(id)) issues.push(`unreachable node ${id}`);
    }
    for (const id of this.lastInvalidation.ids) {
      if (!this.nodes.has(id)) issues.push(`invalidated id ${id} was deleted`);
    }
    return issues;
  }

  hitTest(worldX, worldY) {
    if (!this.rootId) return null;
    const root = this.requireNode(this.rootId);
    const visit = (node) => {
      if (!node.visible) return null;
      const layout = node.cache.layout;
      if (!layout) return null;
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = this.nodes.get(node.children[index]);
        if (!child) continue;
        const hit = visit(child);
        if (hit) return hit;
      }
      const inside =
        worldX >= layout.worldX &&
        worldX <= layout.worldX + layout.width &&
        worldY >= layout.worldY &&
        worldY <= layout.worldY + layout.height;
      return inside ? node : null;
    };
    return visit(root);
  }

  getDependencies(id) {
    const node = this.requireNode(id);
    const parent = this.getParent(node);
    const fontSources = [
      this.getFontSource(node, "fontSize"),
      this.getFontSource(node, "fontFamily"),
      this.getFontSource(node, "fontWeight"),
    ].filter(Boolean);
    return {
      layout: parent ? [parent.id] : [],
      paint: [node.id, ...node.children],
      font: [...new Set(fontSources.filter((source) => source.id !== id).map((source) => source.id))],
    };
  }

  visualHash(commands = this.render()) {
    return fnv1a(stableStringify(commands));
  }

  serializeDocument() {
    const data = [];
    for (const node of this.nodes.values()) {
      const { cache, _resolvedStyle, ...publicNode } = node;
      data.push({
        ...publicNode,
        children: [...node.children],
      });
    }
    return stableStringify(data);
  }

  recordFrameTime(milliseconds) {
    this.stats.lastFrameMs = milliseconds;
    this.stats.frameMs = this.stats.frameMs
      ? this.stats.frameMs * 0.82 + milliseconds * 0.18
      : milliseconds;
  }
}
