import {
  addLog,
  clone,
  ensureResource,
  makeWave,
  recordProjectChange,
  selectedClip,
  shortHash,
  stableStringify
} from "./core.js";

export const MODULE_META = {
  image: {
    name: "图像处理",
    faultStage: "解码图像",
    stages: ["读取对象", "准备资源", "解码图像", "渲染预览"],
    advice(snapshot) {
      const blur = Number(snapshot?.draft?.blur || 0);
      const lead = blur > 4 ? "先把模糊降到 4 px 以下" : "先把亮度保持在 50–150 之间";
      return `${lead}，再点击“重试并复用资源”。当前草稿、选中对象和时间线都保留着。`;
    }
  },
  audio: {
    name: "音频合成",
    faultStage: "合成音频",
    stages: ["读取对象", "准备资源", "合成音频", "写入波形"],
    advice(snapshot) {
      const duration = Number(snapshot?.draft?.duration || 0);
      const lead = duration > 8 ? "把时长缩短到 8 秒以内" : "把基频移到 80–880 Hz 的可合成范围";
      return `${lead}，再重试。已提交波形和未提交参数都还在安全快照中。`;
    }
  },
  export: {
    name: "工程导出",
    faultStage: "编码媒体",
    stages: ["收集时间线", "准备资源", "编码媒体", "生成下载"],
    advice(snapshot) {
      const quality = snapshot?.draft?.quality;
      return `${quality === "高" ? "先把质量改为“平衡”或“快速”" : "先切换容器格式"}，再重试。工程不会因导出失败而被清空。`;
    }
  }
};

const runtimeAssets = new Map();

export class ModuleFailure extends Error {
  constructor(stage, code, message) {
    super(message);
    this.name = "ModuleFailure";
    this.stage = stage;
    this.code = code;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function operationKeyFor(state, moduleId) {
  const clip = selectedClip(state);
  if (moduleId === "image") {
    return `image:${clip?.id || "none"}:${shortHash(state.drafts.image)}`;
  }
  if (moduleId === "audio") {
    return `audio:${clip?.kind === "audio" ? clip.id : "new"}:${shortHash(state.drafts.audio)}`;
  }
  return `export:${shortHash({
    clips: state.clips.map((item) => ({ id: item.id, style: item.style, resourceId: item.resourceId })),
    draft: state.drafts.export
  })}`;
}

function captureSnapshot(state, moduleId, operationKey) {
  const clip = selectedClip(state);
  const module = state.modules[moduleId];
  const relevantClip = moduleId === "audio"
    ? state.clips.find((item) => item.kind === "audio") || clip
    : clip;
  const resource = module.resourceId ? state.resources[module.resourceId] : null;
  return {
    moduleId,
    moduleName: MODULE_META[moduleId].name,
    objectId: relevantClip?.id || null,
    objectName: relevantClip?.name || "工程时间线",
    selectedId: state.selectedId,
    draft: clone(state.drafts[moduleId]),
    committed: clone(relevantClip?.style || null),
    resourceId: module.resourceId,
    resourceKey: resource?.idempotencyKey || operationKey,
    resourceReuses: resource?.reuses || 0,
    timeline: state.clips.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      duration: item.duration
    })),
    capturedAt: Date.now()
  };
}

function shouldInjectFailure(state, moduleId, stage) {
  if (!state.faults[moduleId]) return false;
  if (stage !== MODULE_META[moduleId].faultStage) return false;
  if (!state.faults.persistent) state.faults[moduleId] = false;
  return true;
}

function snapshotLine(snapshot) {
  if (!snapshot) return "无可用快照";
  const parts = [
    `${snapshot.objectName}`,
    `草稿 ${JSON.stringify(snapshot.draft)}`,
    `资源 ${snapshot.resourceId ? `${snapshot.resourceId}（1 份，复用 ${snapshot.resourceReuses} 次）` : "尚未分配"}`
  ];
  return parts.join(" · ");
}

export function snapshotText(snapshot) {
  return snapshotLine(snapshot);
}

async function executeStage(state, moduleId, stage, context) {
  const clip = selectedClip(state);
  const module = state.modules[moduleId];

  if (stage === "读取对象") {
    if (!clip) throw new ModuleFailure(stage, "NO_SELECTION", "时间线中没有可处理对象");
    if (moduleId === "image" && clip.kind !== "image") {
      throw new ModuleFailure(stage, "WRONG_OBJECT", "当前选中对象不是图像，请先选择城市夜景");
    }
    return;
  }

  if (stage === "准备资源") {
    const kind = moduleId === "export" ? "export" : moduleId;
    const label = moduleId === "image"
      ? `${clip.name} · 图像变体`
      : moduleId === "audio"
        ? `${clip.name} · 合成波形`
        : `${state.drafts.export.name}.${state.drafts.export.format}`;
    const { resource, deduplicated } = ensureResource(state, kind, context.operationKey, {
      label,
      payload: state.drafts[moduleId]
    });
    module.resourceId = resource.id;
    addLog(state, {
      level: "info",
      module: MODULE_META[moduleId].name,
      stage,
      attempt: context.attempt,
      operationKey: context.operationKey,
      resourceId: resource.id,
      message: deduplicated
        ? `命中幂等键，复用资源 ${resource.id}；资源数量仍为 1。`
        : `分配资源 ${resource.id}；资源数量为 1。`
    });
    return;
  }

  if (moduleId === "image" && stage === "解码图像") {
    if (state.drafts.image.blur > 16) {
      throw new ModuleFailure(stage, "DECODE_LIMIT", "模糊半径超出浏览器画布上限");
    }
    return;
  }

  if (moduleId === "image" && stage === "渲染预览") {
    const imageClip = state.clips.find((item) => item.kind === "image");
    if (!imageClip) throw new ModuleFailure(stage, "IMAGE_MISSING", "找不到图像图层");
    recordProjectChange(state, "应用图像处理", () => {
      imageClip.style = clone(state.drafts.image);
      imageClip.resourceId = module.resourceId;
    });
    return;
  }

  if (moduleId === "audio" && stage === "合成音频") {
    const blob = synthesizeWavBlob(state.drafts.audio);
    if (!blob || blob.size === 0) throw new ModuleFailure(stage, "DSP_EMPTY", "合成器没有得到有效采样");
    runtimeAssets.set(module.resourceId, { type: "audio/wav", blob });
    return;
  }

  if (moduleId === "audio" && stage === "写入波形") {
    const audioClip = state.clips.find((item) => item.kind === "audio");
    if (!audioClip) throw new ModuleFailure(stage, "AUDIO_MISSING", "找不到音频轨道");
    recordProjectChange(state, "生成音频", () => {
      audioClip.style = clone(state.drafts.audio);
      audioClip.duration = Number(state.drafts.audio.duration);
      audioClip.wave = makeWave(Number(state.drafts.audio.frequency));
      audioClip.resourceId = module.resourceId;
    });
    return;
  }

  if (moduleId === "export" && stage === "收集时间线") {
    if (state.clips.length === 0) throw new ModuleFailure(stage, "TIMELINE_EMPTY", "时间线为空");
    return;
  }

  if (moduleId === "export" && stage === "编码媒体") {
    const manifest = {
      version: 1,
      project: state.title,
      exportedAt: new Date().toISOString(),
      settings: clone(state.drafts.export),
      clips: state.clips.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        start: item.start,
        duration: item.duration,
        style: item.style,
        resourceId: item.resourceId
      })),
      resources: Object.values(state.resources).map((item) => ({
        id: item.id,
        kind: item.kind,
        idempotencyKey: item.idempotencyKey,
        count: item.count
      }))
    };
    const payload = JSON.stringify(manifest, null, 2);
    runtimeAssets.set(module.resourceId, {
      type: "application/json",
      blob: new Blob([payload], { type: "application/json" })
    });
    return;
  }

  if (moduleId === "export" && stage === "生成下载") {
    const asset = runtimeAssets.get(module.resourceId);
    if (!asset?.blob) throw new ModuleFailure(stage, "ENCODE_MISSING", "编码结果不存在，无法生成下载");
    if (context.download !== false) {
      const extension = state.drafts.export.format === "json" ? "json" : "framecraft.json";
      triggerDownload(asset.blob, `${state.drafts.export.name || "export"}.${extension}`);
    }
    return;
  }
}

export async function runModule(state, moduleId, options = {}) {
  const meta = MODULE_META[moduleId];
  const module = state.modules[moduleId];
  if (!meta || !module) throw new Error(`Unknown module: ${moduleId}`);
  if (module.status === "running") return { ok: false, busy: true };

  const isRetry = Boolean(options.isRetry);
  module.operationKey = isRetry && module.operationKey
    ? module.operationKey
    : operationKeyFor(state, moduleId);
  module.attempt += 1;
  module.status = "running";
  module.stage = meta.stages[0];
  module.error = null;
  module.startedAt = Date.now();
  module.completedAt = null;
  module.snapshot = captureSnapshot(state, moduleId, module.operationKey);

  addLog(state, {
    level: "info",
    module: meta.name,
    stage: module.stage,
    attempt: module.attempt,
    operationKey: module.operationKey,
    resourceId: module.resourceId,
    message: isRetry ? "开始重试；沿用原幂等键。" : "开始模块任务。"
  });
  options.onUpdate?.({ moduleId, reason: "start" });
  options.persistState?.();

  try {
    for (const stage of meta.stages) {
      module.stage = stage;
      module.snapshot = captureSnapshot(state, moduleId, module.operationKey);
      options.onUpdate?.({ moduleId, stage });
      options.persistState?.();
      await wait(options.stepDelay ?? 150);
      if (shouldInjectFailure(state, moduleId, stage)) {
        throw new ModuleFailure(stage, `INJECTED_${moduleId.toUpperCase()}`, `已注入${meta.name}故障`);
      }
      await executeStage(state, moduleId, stage, {
        attempt: module.attempt,
        operationKey: module.operationKey,
        download: options.download
      });
    }

    module.status = "ready";
    module.stage = "完成";
    module.error = null;
    module.completedAt = Date.now();
    module.snapshot = captureSnapshot(state, moduleId, module.operationKey);
    state.faults[moduleId] = false;
    addLog(state, {
      level: "success",
      module: meta.name,
      stage: "完成",
      attempt: module.attempt,
      operationKey: module.operationKey,
      resourceId: module.resourceId,
      message: isRetry
        ? `重试成功；资源 ${module.resourceId} 被复用，没有重复创建。`
        : `模块完成；资源 ${module.resourceId} 已写入账本。`
    });
    options.onUpdate?.({ moduleId, reason: "success" });
    options.persistState?.();
    return { ok: true, moduleId, resourceId: module.resourceId };
  } catch (error) {
    const failure = error instanceof ModuleFailure
      ? error
      : new ModuleFailure(module.stage, "UNEXPECTED", String(error?.message || error));
    module.status = "error";
    module.stage = failure.stage;
    module.snapshot = captureSnapshot(state, moduleId, module.operationKey);
    module.error = {
      code: failure.code,
      message: failure.message,
      stage: failure.stage,
      advice: meta.advice(module.snapshot),
      attempt: module.attempt,
      at: Date.now(),
      snapshot: module.snapshot
    };
    addLog(state, {
      level: "error",
      module: meta.name,
      stage: failure.stage,
      attempt: module.attempt,
      operationKey: module.operationKey,
      resourceId: module.resourceId,
      message: `${failure.code}: ${failure.message}。建议：${module.error.advice}`
    });
    options.onUpdate?.({ moduleId, reason: "error" });
    options.persistState?.();
    return { ok: false, moduleId, error: module.error };
  }
}

function synthesizeWavBlob(draft) {
  const sampleRate = 8000;
  const seconds = Math.max(0.25, Math.min(24, Number(draft.duration) || 1));
  const frequency = Math.max(80, Math.min(880, Number(draft.frequency) || 220));
  const sampleCount = Math.floor(sampleRate * seconds);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  const texture = draft.texture === "磁带暖" ? 0.22 : draft.texture === "数字颗粒" ? 0.38 : 0.14;
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const envelope = Math.min(1, time * 8) * Math.min(1, (seconds - time) * 5);
    const drift = Math.sin(time * 2.7) * 8;
    const main = Math.sin(2 * Math.PI * (frequency + drift) * time) * 0.24;
    const harmonic = Math.sin(2 * Math.PI * frequency * 2 * time) * 0.08;
    const noise = Math.sin(index * 12.9898) * texture;
    const sample = Math.max(-1, Math.min(1, (main + harmonic + noise) * envelope));
    view.setInt16(44 + index * 2, sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function getAudioUrl(state) {
  const module = state.modules.audio;
  let asset = runtimeAssets.get(module.resourceId);
  if (!asset?.blob && module.resourceId) {
    const clip = state.clips.find((item) => item.kind === "audio");
    if (clip) {
      asset = { type: "audio/wav", blob: synthesizeWavBlob(clip.style) };
      runtimeAssets.set(module.resourceId, asset);
    }
  }
  if (!asset?.blob) return null;
  const cached = asset.url;
  if (cached) return cached;
  const url = URL.createObjectURL(asset.blob);
  asset.url = url;
  return url;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function resetModuleOperation(state, moduleId) {
  const module = state.modules[moduleId];
  module.status = "ready";
  module.stage = "待处理";
  module.error = null;
  module.snapshot = null;
  module.operationKey = null;
  state.faults[moduleId] = false;
}

export function describeModule(moduleId) {
  return MODULE_META[moduleId]?.name || moduleId;
}

export function projectSignature(state) {
  return shortHash(stableStringify({
    clips: state.clips,
    drafts: state.drafts,
    selectedId: state.selectedId
  }));
}
