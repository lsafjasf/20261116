export const STORAGE_KEYS = {
  primary: "gesture-canvas:snapshot:v1",
  backup: "gesture-canvas:backup:v1"
};

export const WORLD = { width: 1600, height: 1100 };

const seedObjects = [
  {
    id: "note-close",
    type: "note",
    x: 92,
    y: 82,
    width: 230,
    height: 164,
    kicker: "FIELD NOTE / 01",
    title: "先靠近，再决定。",
    body: "不要把重要的事，藏在一屏之外。",
    footer: "林屿 · 刚刚"
  },
  {
    id: "poster-focus",
    type: "poster",
    x: 370,
    y: 54,
    width: 252,
    height: 190,
    kicker: "POSTER / 02",
    title: "Make room for focus.",
    body: "把噪声移出画布。",
    footer: "Studio archive"
  },
  {
    id: "note-blue",
    type: "note-blue",
    x: 668,
    y: 102,
    width: 194,
    height: 146,
    kicker: "IDEA / 03",
    title: "双指缩放时，不要留下笔迹。",
    body: "第二根手指落下，绘制立即取消。",
    footer: "交互规则"
  },
  {
    id: "sticker-world",
    type: "sticker",
    x: 153,
    y: 304,
    width: 168,
    height: 70,
    kicker: "",
    title: "World ↔ Screen",
    body: "",
    footer: ""
  },
  {
    id: "note-warm",
    type: "note-warm",
    x: 375,
    y: 302,
    width: 210,
    height: 152,
    kicker: "REVIEW / 05",
    title: "旋转之后，坐标仍然诚实。",
    body: "对象跟随世界坐标，而不是手指落点。",
    footer: "周意 · 11:42"
  },
  {
    id: "shape-orbit",
    type: "shape",
    x: 656,
    y: 302,
    width: 150,
    height: 150,
    kicker: "",
    title: "Orbit",
    body: "",
    footer: ""
  },
  {
    id: "text-quiet",
    type: "text",
    x: 846,
    y: 82,
    width: 190,
    height: 120,
    kicker: "MARGIN / 07",
    title: "留一点空白给下一次输入。",
    body: "",
    footer: "点击选择 · 长按多选"
  },
  {
    id: "note-small",
    type: "note",
    x: 845,
    y: 302,
    width: 190,
    height: 138,
    kicker: "TODO / 08",
    title: "刷新后，回到刚才的滚动位置。",
    body: "草稿、选择与视口均随快照保存。",
    footer: "验收项"
  }
];

export function createInitialState() {
  return {
    version: 1,
    revision: 1,
    updatedAt: new Date().toISOString(),
    objects: clone(seedObjects),
    strokes: [],
    viewport: { x: 38, y: 42, scale: 1 },
    selectedIds: [],
    multiSelect: false,
    draft: { title: "", body: "" },
    scrollY: 0
  };
}

export function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function finite(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function safeRevision(value) {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function sanitizeObject(object) {
  if (!object || typeof object.id !== "string" || typeof object.title !== "string") {
    throw new Error("对象缺少 id 或标题");
  }
  const type = ["note", "note-warm", "note-blue", "poster", "shape", "sticker", "text"].includes(object.type)
    ? object.type
    : "note";
  return {
    id: object.id.slice(0, 80),
    type,
    x: finite(Number(object.x), 0),
    y: finite(Number(object.y), 0),
    width: Math.min(900, Math.max(80, finite(Number(object.width), 190))),
    height: Math.min(700, Math.max(60, finite(Number(object.height), 130))),
    kicker: String(object.kicker || "").slice(0, 80),
    title: object.title.slice(0, 140),
    body: String(object.body || "").slice(0, 500),
    footer: String(object.footer || "").slice(0, 120)
  };
}

function sanitizeStroke(stroke, index) {
  if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) {
    throw new Error("笔迹数据不完整");
  }
  return {
    id: typeof stroke.id === "string" ? stroke.id.slice(0, 80) : `stroke-${index}`,
    color: /^#[0-9a-f]{6}$/i.test(stroke.color || "") ? stroke.color : "#20231f",
    width: Math.min(30, Math.max(1, finite(Number(stroke.width), 3.5))),
    points: stroke.points.slice(0, 5000).map((point) => ({
      x: finite(Number(point.x), 0),
      y: finite(Number(point.y), 0)
    }))
  };
}

export function sanitizeState(input) {
  if (!input || typeof input !== "object") {
    throw new Error("快照不是有效对象");
  }
  if (!Array.isArray(input.objects) || !Array.isArray(input.strokes)) {
    throw new Error("快照缺少对象或笔迹数组");
  }
  const objects = input.objects.slice(0, 300).map(sanitizeObject);
  const objectIds = new Set(objects.map((object) => object.id));
  const strokes = input.strokes.slice(0, 500).map(sanitizeStroke);
  const viewport = input.viewport || {};
  const draft = input.draft || {};
  return {
    version: 1,
    revision: safeRevision(input.revision),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
    objects,
    strokes,
    viewport: {
      x: finite(Number(viewport.x), 0),
      y: finite(Number(viewport.y), 0),
      scale: Math.min(4, Math.max(0.2, finite(Number(viewport.scale), 1)))
    },
    selectedIds: Array.isArray(input.selectedIds)
      ? [...new Set(input.selectedIds.filter((id) => objectIds.has(id)))].slice(0, 300)
      : [],
    multiSelect: Boolean(input.multiSelect),
    draft: {
      title: String(draft.title || "").slice(0, 80),
      body: String(draft.body || "").slice(0, 500)
    },
    scrollY: Math.max(0, finite(Number(input.scrollY), 0))
  };
}

function readRaw(key) {
  try {
    return { value: localStorage.getItem(key) || "", error: null };
  } catch (error) {
    return { value: "", error: `无法读取 ${key}：${error.message}` };
  }
}

export class SnapshotStore {
  constructor() {
    this.lastError = null;
  }

  load() {
    const primaryRead = readRaw(STORAGE_KEYS.primary);
    const backupRead = readRaw(STORAGE_KEYS.backup);
    const primaryRaw = primaryRead.value;
    const backupRaw = backupRead.value;
    const errors = [];
    if (primaryRead.error) errors.push(primaryRead.error);
    if (backupRead.error) errors.push(backupRead.error);

    if (primaryRaw) {
      try {
        return {
          state: sanitizeState(JSON.parse(primaryRaw)),
          source: "primary",
          recovery: null
        };
      } catch (error) {
        errors.push(`主快照：${error.message}`);
      }
    }

    if (backupRaw) {
      try {
        return {
          state: sanitizeState(JSON.parse(backupRaw)),
          source: "backup",
          recovery: {
            message: `${errors[0] || "未找到主快照"}。已从备份恢复，原始内容仍保留在下方。`,
            raw: primaryRaw || backupRaw
          }
        };
      } catch (error) {
        errors.push(`备份快照：${error.message}`);
      }
    }

    if (primaryRaw || backupRaw || errors.length) {
      return {
        state: createInitialState(),
        source: "fallback",
        recovery: {
          message: `${errors.join("；") || "快照均不可读"}。画布已使用安全空白状态，原始快照仍保留在下方。`,
          raw: [primaryRaw, backupRaw].filter(Boolean).join("\n\n")
        }
      };
    }

    return { state: createInitialState(), source: "new", recovery: null };
  }

  save(state) {
    const serialized = JSON.stringify(state);
    try {
      localStorage.setItem(STORAGE_KEYS.backup, serialized);
      localStorage.setItem(STORAGE_KEYS.primary, serialized);
      this.lastError = null;
      return { ok: true, at: new Date().toISOString(), bytes: serialized.length };
    } catch (error) {
      this.lastError = error;
      return { ok: false, at: new Date().toISOString(), error: error.message };
    }
  }

  readableSnapshot(state, extras = {}) {
    const { input, storage } = extras;
    return JSON.stringify({
      revision: state.revision,
      updatedAt: state.updatedAt,
      viewport: {
        x: Math.round(state.viewport.x),
        y: Math.round(state.viewport.y),
        scale: Number(state.viewport.scale.toFixed(3))
      },
      selection: state.selectedIds,
      multiSelect: state.multiSelect,
      pageScrollY: Math.round(state.scrollY),
      draft: state.draft,
      objects: state.objects.map(({ id, type, title, x, y, width, height }) => ({
        id, type, title, x, y, width, height
      })),
      strokes: state.strokes.map(({ id, points }) => ({ id, points: points.length })),
      sync: { input, storage }
    }, null, 2);
  }
}
