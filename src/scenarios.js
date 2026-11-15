import { SceneEngine, fnv1a, stableStringify } from "./engine.js";

export const SCENE_SIZE = { width: 940, height: 660 };

function add(engine, parentId, props) {
  return engine.add(parentId, props);
}

export function populateScene(engine) {
  add(engine, null, {
    id: "root",
    name: "画布 01",
    type: "group",
    x: 0,
    y: 0,
    width: SCENE_SIZE.width,
    height: SCENE_SIZE.height,
    fill: "#F2EDE3",
    clip: true,
  });

  add(engine, "root", {
    id: "backdropSun",
    name: "背景光斑",
    type: "ellipse",
    x: 666,
    y: -112,
    width: 350,
    height: 350,
    fill: "#E8C79A",
    opacity: 0.68,
  });

  add(engine, "root", {
    id: "hero",
    name: "Hero 卡片",
    type: "group",
    x: 40,
    y: 40,
    width: 500,
    height: 580,
    fill: "#FCF9F1",
    radius: 26,
    clip: true,
    shadow: {
      color: "rgba(45, 52, 42, 0.12)",
      blur: 34,
      offsetY: 16,
    },
  });

  add(engine, "hero", {
    id: "heroPill",
    name: "期号底",
    type: "rect",
    x: 28,
    y: 26,
    width: 70,
    height: 22,
    radius: 11,
    fill: "#DF634B",
  });
  add(engine, "hero", {
    id: "heroPillText",
    name: "期号",
    type: "text",
    x: 28,
    y: 31,
    width: 70,
    height: 11,
    text: "ISSUE 03",
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 0.8,
    align: "center",
    color: "#FFF9F1",
  });
  add(engine, "hero", {
    id: "heroKicker",
    name: "眉题",
    type: "text",
    x: 28,
    y: 72,
    right: 28,
    height: 15,
    text: "A STUDY OF SOFT LIGHT / 2026",
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: 1.25,
    color: "#797D6D",
  });
  add(engine, "hero", {
    id: "heroTitle",
    name: "标题组",
    type: "group",
    x: 28,
    y: 104,
    right: 28,
    height: 190,
    fontSize: 68,
    fontFamily: '"Noto Serif SC", "Iowan Old Style", "Songti SC", serif',
    fontWeight: 500,
    color: "#1F2A22",
  });
  add(engine, "heroTitle", {
    id: "titleA",
    name: "春日",
    type: "text",
    x: 0,
    y: 0,
    right: 0,
    height: 76,
    text: "春日",
    lineHeight: 1,
  });
  add(engine, "heroTitle", {
    id: "titleB",
    name: "序章",
    type: "text",
    x: 0,
    y: 78,
    right: 0,
    height: 76,
    text: "序章",
    lineHeight: 1,
  });
  add(engine, "heroTitle", {
    id: "titleLatin",
    name: "英文副题",
    type: "text",
    x: 1,
    y: 170,
    right: 0,
    height: 14,
    text: "SPRING EDITORIAL",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 1.8,
    lineHeight: 1,
    color: "#A35D43",
  });
  add(engine, "hero", {
    id: "heroCopy",
    name: "引言",
    type: "text",
    x: 28,
    y: 318,
    right: 34,
    height: 48,
    text: "让光线慢下来。用纹理、留白与克制的颜色，记录季节最初的呼吸。",
    fontSize: 13.2,
    fontWeight: 450,
    lineHeight: 1.55,
    color: "#60675B",
  });
  add(engine, "hero", {
    id: "heroArtwork",
    name: "装饰层 / Still life",
    type: "group",
    x: 28,
    y: 382,
    right: 28,
    height: 158,
    fill: "#D8D9C7",
    radius: 16,
    clip: true,
  });
  add(engine, "heroArtwork", {
    id: "artSun",
    name: "暖色圆形",
    type: "ellipse",
    x: -54,
    y: -96,
    width: 242,
    height: 242,
    fill: "#E8B16A",
  });
  add(engine, "heroArtwork", {
    id: "artArch",
    name: "墨绿拱形",
    type: "rect",
    x: 302,
    y: 17,
    width: 116,
    height: 170,
    radius: 58,
    fill: "#2B4736",
  });
  add(engine, "heroArtwork", {
    id: "artCream",
    name: "奶油球",
    type: "ellipse",
    x: 166,
    y: 28,
    width: 80,
    height: 80,
    fill: "#EFE4C9",
  });
  add(engine, "heroArtwork", {
    id: "artCaption",
    name: "材质标注",
    type: "text",
    x: 15,
    y: 137,
    width: 130,
    height: 12,
    text: "MATERIAL / 04",
    fontSize: 7,
    fontWeight: 700,
    letterSpacing: 1,
    color: "#59614F",
  });
  add(engine, "hero", {
    id: "heroFooter",
    name: "页脚",
    type: "group",
    x: 28,
    bottom: 20,
    right: 28,
    height: 24,
  });
  add(engine, "heroFooter", {
    id: "heroRule",
    name: "分隔线",
    type: "line",
    x: 0,
    y: 0,
    right: 0,
    height: 0,
    stroke: "#D9D2C3",
    strokeWidth: 1,
  });
  add(engine, "heroFooter", {
    id: "heroFooterText",
    name: "页脚文字",
    type: "text",
    x: 0,
    y: 9,
    right: 0,
    height: 12,
    text: "LIGHT STUDY / LIMITED EDITION",
    fontSize: 7,
    fontWeight: 650,
    letterSpacing: 1.15,
    color: "#969989",
  });

  add(engine, "root", {
    id: "insight",
    name: "数据洞察卡",
    type: "group",
    x: 572,
    y: 40,
    width: 328,
    height: 294,
    fill: "#24372D",
    radius: 24,
    clip: true,
    shadow: {
      color: "rgba(36, 55, 45, 0.18)",
      blur: 30,
      offsetY: 14,
    },
  });
  add(engine, "insight", {
    id: "insightLabel",
    name: "卡片标签",
    type: "text",
    x: 24,
    y: 24,
    right: 24,
    height: 12,
    text: "MARKET PULSE / 2026",
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 1.45,
    color: "#8FA69A",
  });
  add(engine, "insight", {
    id: "insightNumber",
    name: "核心数字",
    type: "text",
    x: 24,
    y: 48,
    right: 24,
    height: 72,
    text: "62%",
    fontSize: 62,
    fontFamily: '"Noto Serif SC", "Iowan Old Style", "Songti SC", serif',
    fontWeight: 500,
    lineHeight: 1,
    color: "#F2E9D8",
  });
  add(engine, "insight", {
    id: "insightBody",
    name: "解读",
    type: "text",
    x: 24,
    y: 126,
    right: 24,
    height: 32,
    text: "受众更偏好自然纹理与低饱和色。",
    fontSize: 11,
    fontWeight: 500,
    lineHeight: 1.45,
    color: "#B7C6BB",
  });
  add(engine, "insight", {
    id: "insightRule",
    name: "分隔线",
    type: "line",
    x: 24,
    y: 172,
    right: 24,
    height: 0,
    stroke: "#496052",
    strokeWidth: 1,
  });
  add(engine, "insight", {
    id: "insightBars",
    name: "数据柱",
    type: "group",
    x: 24,
    y: 190,
    right: 24,
    height: 54,
  });
  add(engine, "insightBars", {
    id: "barWarm",
    name: "暖沙",
    type: "rect",
    x: "0%",
    y: 14,
    width: "19%",
    height: 40,
    radius: 6,
    fill: "#D9A860",
  });
  add(engine, "insightBars", {
    id: "barClay",
    name: "陶土",
    type: "rect",
    x: "23%",
    y: 0,
    width: "28%",
    height: 54,
    radius: 6,
    fill: "#DF634B",
  });
  add(engine, "insightBars", {
    id: "barMoss",
    name: "苔绿",
    type: "rect",
    x: "55%",
    y: 24,
    width: "19%",
    height: 30,
    radius: 6,
    fill: "#8DA792",
  });
  add(engine, "insightBars", {
    id: "barLinen",
    name: "亚麻",
    type: "rect",
    x: "78%",
    y: 8,
    width: "22%",
    height: 46,
    radius: 6,
    fill: "#E6DDC8",
  });
  add(engine, "insight", {
    id: "insightCaption",
    name: "图表注释",
    type: "text",
    x: 24,
    y: 262,
    right: 24,
    height: 12,
    text: "SAMPLE 1,204 · Q1 — Q4",
    fontSize: 7,
    fontWeight: 650,
    letterSpacing: 0.75,
    color: "#83988B",
  });

  add(engine, "root", {
    id: "notes",
    name: "编辑手记卡",
    type: "group",
    x: 572,
    y: 352,
    width: 328,
    height: 268,
    fill: "#FBF8F0",
    radius: 24,
    clip: true,
    shadow: {
      color: "rgba(45, 52, 42, 0.1)",
      blur: 26,
      offsetY: 12,
    },
  });
  add(engine, "notes", {
    id: "notesLabel",
    name: "卡片标签",
    type: "text",
    x: 24,
    y: 22,
    right: 24,
    height: 12,
    text: "FIELD NOTES / 02",
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: 1.4,
    color: "#9B725B",
  });
  add(engine, "notes", {
    id: "notesHeading",
    name: "手记标题",
    type: "text",
    x: 24,
    y: 45,
    right: 24,
    height: 60,
    text: "把春天\n放慢一点",
    fontSize: 26,
    fontFamily: '"Noto Serif SC", "Iowan Old Style", "Songti SC", serif',
    fontWeight: 500,
    lineHeight: 1.12,
    color: "#263329",
  });
  add(engine, "notes", {
    id: "notesBody",
    name: "正文",
    type: "text",
    x: 24,
    y: 121,
    right: 24,
    height: 48,
    text: "留白不是空白，而是让观看发生的地方。",
    fontSize: 10.5,
    fontWeight: 450,
    lineHeight: 1.6,
    color: "#767B6F",
  });
  add(engine, "notes", {
    id: "palette",
    name: "色板",
    type: "group",
    x: 24,
    y: 190,
    right: 24,
    height: 28,
  });
  add(engine, "palette", {
    id: "swatchMoss",
    name: "苔绿",
    type: "ellipse",
    x: 0,
    y: 2,
    width: 24,
    height: 24,
    fill: "#2B4736",
  });
  add(engine, "palette", {
    id: "swatchClay",
    name: "陶土",
    type: "ellipse",
    x: 31,
    y: 2,
    width: 24,
    height: 24,
    fill: "#DF634B",
  });
  add(engine, "palette", {
    id: "swatchLinen",
    name: "亚麻",
    type: "ellipse",
    x: 62,
    y: 2,
    width: 24,
    height: 24,
    fill: "#D8CFB9",
  });
  add(engine, "palette", {
    id: "paletteText",
    name: "色板说明",
    type: "text",
    x: 100,
    y: 8,
    right: 0,
    height: 12,
    text: "MOSS / CLAY / LINEN",
    fontSize: 7,
    fontWeight: 650,
    letterSpacing: 0.9,
    color: "#929588",
  });
  add(engine, "notes", {
    id: "notesFoot",
    name: "页脚",
    type: "text",
    x: 24,
    bottom: 18,
    right: 24,
    height: 12,
    text: "LATTICE PRESS — SHANGHAI",
    fontSize: 7,
    fontWeight: 650,
    letterSpacing: 1.05,
    color: "#AAA99F",
  });

  return engine;
}

export function createSceneEngine(options = {}) {
  const engine = new SceneEngine({
    measureText: options.measureText,
    invalidation: options.invalidation ?? "fine",
    name: options.name ?? "spring-editorial",
  });
  populateScene(engine);
  return engine;
}

export const CHANGE_ACTIONS = [
  {
    id: "resize",
    label: "父尺寸",
    detail: "Hero 卡片 500 × 580 → 420 × 580",
    target: "hero",
    reason: "resize:parent",
  },
  {
    id: "font",
    label: "继承字体",
    detail: "标题组 68 px → 78 px",
    target: "heroTitle",
    reason: "font:inherit",
  },
  {
    id: "visibility",
    label: "图层显隐",
    detail: "装饰层 visible → false",
    target: "heroArtwork",
    reason: "visibility:layer",
  },
  {
    id: "delete",
    label: "删除清理",
    detail: "删除装饰层及其 4 个子节点",
    target: "heroArtwork",
    reason: "delete:subtree",
  },
];

export function applyChange(engine, actionId, { boundary = false } = {}) {
  if (actionId === "resize") {
    engine.updateNode(
      "hero",
      boundary ? { width: 280, height: 430 } : { width: 420, height: 580 },
      "resize:parent",
    );
    return;
  }
  if (actionId === "font") {
    engine.setFontSize("heroTitle", boundary ? 88 : 78);
    return;
  }
  if (actionId === "visibility") {
    engine.setVisible("heroArtwork", false);
    return;
  }
  if (actionId === "delete") {
    engine.deleteNode("heroArtwork");
    return;
  }
  throw new Error(`Unknown action: ${actionId}`);
}

function countCommands(commands) {
  let total = 0;
  for (const command of commands) {
    total += 1;
    if (command.kind === "group") total += countCommands(command.commands);
  }
  return total;
}

function interactionProbe(engine) {
  const points = [
    [90, 90],
    [260, 240],
    [620, 120],
    [760, 430],
    [470, 8],
  ];
  return points.map(([x, y]) => engine.hitTest(x, y)?.id ?? null);
}

function runSingle(mode, measureText, boundary) {
  const started = performance.now();
  const exceptions = [];
  let engine;
  let commands = [];
  let initialVisualHash = null;
  try {
    engine = createSceneEngine({
      measureText,
      invalidation: mode === "before" || mode === "boundary-oracle" ? "full" : "fine",
      name: `benchmark-${mode}`,
    });
    commands = engine.render();
    initialVisualHash = engine.visualHash(commands);
    engine.resetStats();
    engine.recomputeLog = [];
  } catch (error) {
    exceptions.push(`initialize: ${error.message}`);
    return {
      mode,
      boundary,
      exceptions,
      actionResults: [],
      visualHash: null,
      documentHash: null,
      interactionHash: null,
      valid: false,
    };
  }

  const actionResults = [];
  for (const action of CHANGE_ACTIONS) {
    try {
      applyChange(engine, action.id, { boundary });
      const invalidation = engine.lastInvalidation;
      const frameStart = performance.now();
      commands = engine.render();
      const frameMs = performance.now() - frameStart;
      engine.recordFrameTime(frameMs);
      const issues = engine.validateInvariants();
      if (issues.length) exceptions.push(`${action.id}: ${issues.join("; ")}`);
      actionResults.push({
        id: action.id,
        label: action.label,
        detail: action.detail,
        candidateCount: invalidation.candidateCount,
        layoutCandidates: invalidation.layoutCandidates,
        paintCandidates: invalidation.paintCandidates,
        layoutRecomputes: engine.lastUpdate.layoutRecomputes,
        paintRecomputes: engine.lastUpdate.paintRecomputes,
        hits: engine.lastUpdate.layoutHits + engine.lastUpdate.paintHits,
        misses: engine.lastUpdate.layoutMisses + engine.lastUpdate.paintMisses,
        frameMs,
        deletedCount: invalidation.deletedCount,
      });
    } catch (error) {
      exceptions.push(`${action.id}: ${error.message}`);
    }
  }

  let danglingCount = 0;
  let issues = [];
  try {
    issues = engine.validateInvariants();
    danglingCount = issues.length;
    if (issues.length) exceptions.push(`invariants: ${issues.join("; ")}`);
  } catch (error) {
    exceptions.push(`invariants: ${error.message}`);
  }
  const metrics = engine.getMetrics();
  const totalRecomputes = metrics.layoutRecomputes + metrics.paintRecomputes;
  return {
    mode,
    boundary,
    actionResults,
    visualHash: engine.visualHash(commands),
    documentHash: fnv1a(engine.serializeDocument()),
    interactionHash: fnv1a(stableStringify(interactionProbe(engine))),
      initialVisualHash,
    frameTimes: actionResults.map((action) => action.frameMs),
    avgFrameMs: actionResults.length
      ? actionResults.reduce((sum, action) => sum + action.frameMs, 0) / actionResults.length
      : 0,
    totalMs: performance.now() - started,
    layoutRecomputes: metrics.layoutRecomputes,
    paintRecomputes: metrics.paintRecomputes,
    totalRecomputes,
    hitRate: metrics.hitRate,
    layoutHits: metrics.layoutHits,
    paintHits: metrics.paintHits,
    misses: metrics.layoutMisses + metrics.paintMisses,
    candidateTotal: actionResults.reduce((sum, action) => sum + action.candidateCount, 0),
    nodeCount: metrics.nodeCount,
    cacheEntries: metrics.cacheEntries,
    commandCount: countCommands(commands),
    danglingCount,
    exceptions,
    invariantIssues: issues,
    deletedCount: engine.lastDeletion?.deletedCount ?? 0,
    valid: exceptions.length === 0 && danglingCount === 0,
  };
}

export function runComparison({ measureText } = {}) {
  const before = runSingle("before", measureText, false);
  const after = runSingle("after", measureText, false);
  const boundary = runSingle("boundary", measureText, true);
  const boundaryOracle = runSingle("boundary-oracle", measureText, true);
  const visualEqual = before.visualHash === after.visualHash;
  const documentEqual = before.documentHash === after.documentHash;
  const interactionEqual = before.interactionHash === after.interactionHash;
  const boundaryVisualEqual = boundary.visualHash === boundaryOracle.visualHash;
  const boundaryDocumentEqual = boundary.documentHash === boundaryOracle.documentHash;
  const boundaryInteractionEqual = boundary.interactionHash === boundaryOracle.interactionHash;
  const fewerRecomputes = after.totalRecomputes < before.totalRecomputes;
  const higherHitRate = after.hitRate > before.hitRate;
  const noExceptions = [before, after, boundary].every((run) => run.valid);
  const recomputeSaved = before.totalRecomputes
    ? 1 - after.totalRecomputes / before.totalRecomputes
    : 0;
  return {
    generatedAt: new Date().toISOString(),
    before,
    after,
    boundary,
    boundaryOracle,
    checks: {
      visualEqual,
      documentEqual,
      interactionEqual,
      boundaryVisualEqual,
      boundaryDocumentEqual,
      boundaryInteractionEqual,
      fewerRecomputes,
      higherHitRate,
      noExceptions,
      noDanglingReferences: [before, after, boundary].every((run) => run.danglingCount === 0),
    },
    summary: {
      semanticEquivalent: visualEqual && documentEqual && interactionEqual,
      boundaryEquivalent:
        boundaryVisualEqual && boundaryDocumentEqual && boundaryInteractionEqual,
      recomputeSaved,
      candidateReduction: before.candidateTotal
        ? 1 - after.candidateTotal / before.candidateTotal
        : 0,
      pass:
        visualEqual &&
        documentEqual &&
        interactionEqual &&
        boundaryVisualEqual &&
        boundaryDocumentEqual &&
        boundaryInteractionEqual &&
        fewerRecomputes &&
        higherHitRate &&
        noExceptions,
    },
  };
}
