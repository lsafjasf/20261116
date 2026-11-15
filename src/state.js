export const STORAGE_KEYS = {
  template: "kinetic.template.v1",
  instances: "kinetic.instances.v1",
  project: "kinetic.project.v1"
};

export const SCHEMAS = {
  template: "kinetic.template/v1",
  instance: "kinetic.instance/v1",
  project: "kinetic.project/v1"
};

const now = () => new Date().toISOString();

export function createTemplate() {
  return {
    schema: SCHEMAS.template,
    id: "T-ATLAS-04",
    name: "Atlas / Product Pulse",
    version: 4,
    createdAt: "2026-11-16T01:00:00.000Z",
    updatedAt: now(),
    width: 1280,
    height: 720,
    format: "16:9",
    tempo: "pulse",
    accent: "#D7FF45",
    cardCount: 3,
    cardGap: 16,
    transition: "orbit",
    keyframes: [
      { id: "K-01", time: 0, x: 76, y: 0, opacity: 0, color: "#D7FF45" },
      { id: "K-02", time: 1.25, x: 76, y: 0, opacity: 1, color: "#D7FF45" },
      { id: "K-03", time: 6, x: 102, y: -8, opacity: 1, color: "#FF7048" },
      { id: "K-04", time: 12, x: 76, y: 0, opacity: 1, color: "#8F9CF0" }
    ]
  };
}

export function createInstances(templateId = "T-ATLAS-04", templateVersion = 4) {
  return [
    {
      schema: SCHEMAS.instance,
      id: "INST-01",
      name: "短文案 / Signal",
      variant: "short",
      templateId,
      templateVersion,
      kicker: "GROWTH / Q3 SIGNAL",
      title: "把增长，变成看得见的节奏。",
      createdAt: "2026-11-16T01:01:00.000Z",
      updatedAt: now()
    },
    {
      schema: SCHEMAS.instance,
      id: "INST-02",
      name: "长文案 / Story",
      variant: "long",
      templateId,
      templateVersion,
      kicker: "GROWTH / Q3 SIGNAL",
      title: "从每一次真实成交出发，让增长在十二秒内被看见、被理解、被记住。",
      createdAt: "2026-11-16T01:02:00.000Z",
      updatedAt: now()
    }
  ];
}

export function createProject(template, instances, dataState = {}, extra = {}) {
  return {
    schema: SCHEMAS.project,
    id: "PRJ-ATLAS-2026",
    name: "Atlas 2026 / 数据叙事发布片",
    savedAt: now(),
    templateId: template.id,
    templateVersion: template.version,
    template,
    instances,
    dataState: {
      sampleId: dataState.sampleId || "A",
      filter: dataState.filter || "all",
      revision: dataState.revision || 0,
      ...dataState
    },
    verification: extra
  };
}

export function auditReferences(template, instances) {
  const linked = instances.filter((instance) => instance.templateId === template.id);
  const orphaned = instances.filter((instance) => instance.templateId !== template.id);
  return {
    templateId: template.id,
    templateVersion: template.version,
    totalInstances: instances.length,
    linked: linked.map((instance) => ({
      id: instance.id,
      variant: instance.variant,
      templateId: instance.templateId,
      resolved: instance.templateId === template.id
    })),
    orphaned: orphaned.map((instance) => ({ id: instance.id, templateId: instance.templateId })),
    ok: orphaned.length === 0 && linked.length === instances.length,
    checkedAt: now()
  };
}

export function persistTemplate(template) {
  localStorage.setItem(STORAGE_KEYS.template, JSON.stringify(template));
}

export function persistInstances(instances) {
  localStorage.setItem(STORAGE_KEYS.instances, JSON.stringify(instances));
}

export function persistProject(project) {
  localStorage.setItem(STORAGE_KEYS.project, JSON.stringify(project));
}

export function loadTemplateFromStore() {
  const raw = localStorage.getItem(STORAGE_KEYS.template);
  return raw ? JSON.parse(raw) : null;
}

export function loadInstancesFromStore() {
  const raw = localStorage.getItem(STORAGE_KEYS.instances);
  return raw ? JSON.parse(raw) : null;
}

export function loadProjectFromStore() {
  const raw = localStorage.getItem(STORAGE_KEYS.project);
  return raw ? JSON.parse(raw) : null;
}

export function validateBundle(bundle) {
  if (!bundle || bundle.schema !== SCHEMAS.project) throw new Error("工程 schema 不匹配");
  if (!bundle.template || bundle.template.schema !== SCHEMAS.template) throw new Error("模板段缺失");
  if (!Array.isArray(bundle.instances)) throw new Error("实例段缺失");
  if (!bundle.instances.every((instance) => instance.schema === SCHEMAS.instance)) {
    throw new Error("实例 schema 不匹配");
  }
  const audit = auditReferences(bundle.template, bundle.instances);
  if (!audit.ok) throw new Error("工程存在失效的模板引用");
  return bundle;
}

export function installBundle(bundle) {
  const valid = validateBundle(bundle);
  persistTemplate(valid.template);
  persistInstances(valid.instances);
  persistProject(valid);
  return valid;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signature(value) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `0x${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function countSceneNodes(template, instance, cardCount) {
  const base = 9;
  return base + template.keyframes.length + cardCount * 2 + (instance.title.length > 18 ? 2 : 0);
}

export function makeSnapshot({ template, instances, instance, result, cards, layout, stageSignature }) {
  return {
    capturedAt: now(),
    objectCount: {
      templates: 1,
      instances: instances.length,
      sceneNodes: countSceneNodes(template, instance, cards.length),
      acceptedRecords: result.acceptedCount
    },
    keyValues: {
      sampleId: result.sampleId,
      dataVersion: result.version,
      filter: result.filter,
      acceptedRecords: result.acceptedCount,
      duplicates: result.quality.duplicates,
      nulls: result.quality.nulls,
      outliers: result.quality.outliers,
      primary: Number(result.calculated[samplePrimary(result.sampleId)].toFixed(2)),
      secondary: Number(result.calculated[sampleSecondary(result.sampleId)].toFixed(2)),
      cards: cards.map((card) => `${card.label}:${card.value}`),
      titleLength: instance.title.length,
      layoutLines: layout.lines,
      keyframes: template.keyframes.length
    },
    hashes: {
      template: signature(template),
      instance: signature(instance),
      data: signature(result.calculated),
      stage: stageSignature
    }
  };
}

function samplePrimary(sampleId) {
  return sampleId === "A" ? "revenue" : "hours";
}

function sampleSecondary(sampleId) {
  return sampleId === "A" ? "orders" : "spend";
}

export function compareSnapshots(before, after) {
  if (!before || !after) return { ok: false, reasons: ["缺少快照"] };
  const reasons = [];
  const beforeObjects = JSON.stringify(before.objectCount);
  const afterObjects = JSON.stringify(after.objectCount);
  if (beforeObjects !== afterObjects) reasons.push("对象数量变化");
  for (const key of Object.keys(before.keyValues)) {
    if (JSON.stringify(before.keyValues[key]) !== JSON.stringify(after.keyValues[key])) {
      reasons.push(`关键值变化：${key}`);
    }
  }
  for (const key of Object.keys(before.hashes)) {
    if (before.hashes[key] !== after.hashes[key]) reasons.push(`签名变化：${key}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function nextInstanceVersion(instance) {
  const match = /^INST-(\d+)$/.exec(instance.id || "");
  const number = match ? Number(match[1]) : 0;
  return { ...instance, updatedAt: now(), version: (instance.version || 1) + 1 };
}
