import {
  SAMPLES,
  TOOLS,
  getDamage,
  getSample,
  getTool
} from "./samples.js";

export const FIXED_STEP = 1 / 30;
export const STATE_LABELS = {
  inspect: "待修复",
  repairing: "处理中",
  paused: "已暂停",
  ready: "待归档",
  failed: "故障",
  archived: "已归档"
};

const INITIAL_RESOURCES = {
  cpu: 260,
  memory: 512,
  integrity: 100
};

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function hashString(input) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const text = String(input);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + index;
    h2 = Math.imul(h2, 0x85ebca6b);
    h2 ^= h2 >>> 13;
  }
  h1 >>>= 0;
  h2 >>>= 0;
  return `${h1.toString(16).padStart(8, "0")}${h2
    .toString(16)
    .padStart(8, "0")}`;
}

export const SOURCE_HASHES = Object.freeze(
  Object.fromEntries(
    SAMPLES.map((sample) => [sample.id, hashString(stableStringify(sample))])
  )
);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, precision = 4) => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};
const copy = (value) => JSON.parse(JSON.stringify(value));

function requiredTools(sample) {
  return TOOLS.filter((tool) => sample.damage.includes(tool.damage));
}

function initialMetrics(sample) {
  const hasDrop = sample.damage.includes("drop");
  const hasGrain = sample.damage.includes("grain");
  const videoDamageCount = Number(hasDrop) + Number(hasGrain);
  return {
    audio: sample.damage.includes("hum") ? 31 : 84,
    video: videoDamageCount === 0 ? 86 : videoDamageCount === 2 ? 34 : 43,
    sync: sample.damage.includes("drift") ? 24 : 86
  };
}

function initialProject(sample) {
  return {
    state: "inspect",
    diagnostics: [],
    repairs: {},
    metrics: initialMetrics(sample),
    mediaPlayhead: 0,
    playing: false,
    activeJob: null,
    error: null,
    verification: null,
    summary: null,
    lastChange: {
      code: "SAMPLE_READY",
      title: "样本载入",
      detail: `${sample.code} 已挂载为只读素材，等待损伤判读`,
      at: 0
    }
  };
}

function archiveStamp(seed) {
  const base = Date.UTC(2026, 10, 16, 2, 17, 0);
  return new Date(base + (seed % 3600) * 1000).toISOString();
}

export class RestorationEngine {
  constructor({ seed = 17042, selectedId = SAMPLES[0].id } = {}) {
    this.seed = seed >>> 0;
    this.initialSelectedId = getSample(selectedId).id;
    this.reset();
  }

  reset() {
    this.selectedId = this.initialSelectedId;
    this.rngState = this.seed || 1;
    this.tickCount = 0;
    this.sessionSeconds = 0;
    this.resources = { ...INITIAL_RESOURCES };
    this.project = initialProject(getSample(this.selectedId));
    this.snapshots = [];
    this.archives = [];
    this.commandLog = [];
    this.mutationCount = 0;
    this.finalStateHash = null;
    this.replayResult = null;
    this._change("RESET", "会话复位", "计时器、播放头、资源与随机序列回到初始值");
    return this;
  }

  get sample() {
    return getSample(this.selectedId);
  }

  get currentState() {
    return this.project.state;
  }

  get isPaused() {
    return this.project.state === "paused";
  }

  random() {
    let value = (this.rngState += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    this.rngState = value >>> 0;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  _change(code, title, detail) {
    this.project.lastChange = {
      code,
      title,
      detail,
      at: round(this.sessionSeconds, 3)
    };
    this.mutationCount += 1;
  }

  _log(type, payload = {}) {
    this.commandLog.push({
      tick: this.tickCount,
      type,
      ...copy(payload)
    });
  }

  _snapshot(label) {
    this.snapshots.push({
      label,
      selectedId: this.selectedId,
      project: copy(this.project),
      resources: copy(this.resources)
    });
    if (this.snapshots.length > 16) this.snapshots.shift();
  }

  _restore(snapshot) {
    this.selectedId = snapshot.selectedId;
    this.project = copy(snapshot.project);
    this.resources = copy(snapshot.resources);
    this.project.activeJob = null;
    this.project.playing = false;
    this.mutationCount += 1;
  }

  _fail(code, title, detail, { integrityCost = 2 } = {}) {
    this.project.activeJob = null;
    this.project.playing = false;
    this.project.state = "failed";
    this.project.error = { code, title, detail };
    this.resources.integrity = clamp(
      this.resources.integrity - integrityCost,
      0,
      100
    );
    this._change(code, title, detail);
    return { ok: false, code, error: this.project.error };
  }

  selectSample(id) {
    const sample = getSample(id);
    if (
      this.project.state === "repairing" ||
      this.project.state === "paused"
    ) {
      return { ok: false, code: "BUSY" };
    }
    if (sample.id === this.selectedId) return { ok: true, sample };
    this.selectedId = sample.id;
    this.project = initialProject(sample);
    this.snapshots = [];
    this.project.mediaPlayhead = 0;
    this._change(
      "SAMPLE_SELECT",
      "切换样本",
      `${sample.code} / ${sample.title}`
    );
    this._log("selectSample", { sampleId: sample.id });
    return { ok: true, sample };
  }

  diagnose(damageId) {
    const damage = getDamage(damageId);
    if (!damage) return { ok: false, code: "UNKNOWN_DAMAGE" };
    if (this.project.state !== "inspect") {
      return { ok: false, code: "INVALID_STATE" };
    }
    if (this.project.diagnostics.includes(damageId)) {
      return { ok: false, code: "ALREADY_DIAGNOSED" };
    }
    if (!this.sample.damage.includes(damageId)) {
      this._snapshot("错误损伤判读前");
      this._log("diagnose", { damageId });
      return this._fail(
        "DIAGNOSIS_MISMATCH",
        "损伤判读不符",
        `当前波形与画面没有「${damage.label}」特征，请回滚快照重新判读`,
        { integrityCost: 3 }
      );
    }
    this._snapshot(`标记 ${damage.label}`);
    this.project.diagnostics.push(damageId);
    this.project.diagnostics.sort();
    this._change(
      "DAMAGE_MARKED",
      "标记损伤",
      `${damage.label} · ${damage.short}`
    );
    this._log("diagnose", { damageId });
    if (this.project.diagnostics.length === this.sample.damage.length) {
      this._change(
        "DIAGNOSIS_COMPLETE",
        "损伤判读完成",
        `已识别 ${this.sample.damage.length} 类损伤，修复序列已开放`
      );
    }
    return { ok: true, diagnostics: [...this.project.diagnostics] };
  }

  get requiredTools() {
    return requiredTools(this.sample).map((tool) => tool.id);
  }

  get missingTools() {
    return this.requiredTools.filter((id) => !this.project.repairs[id]);
  }

  get diagnosisComplete() {
    return this.sample.damage.every((id) =>
      this.project.diagnostics.includes(id)
    );
  }

  get currentGoal() {
    const state = this.project.state;
    if (state === "failed") return "回滚到最近快照，排除故障后继续";
    if (state === "paused") return "确认参数并恢复修复工序";
    if (state === "archived") return "检索修复片段并导出档案索引";
    if (state === "ready") return "核对音画指标，保存摘要并归档";
    if (state === "repairing") {
      const tool = getTool(this.project.activeJob?.toolId);
      return tool ? `正在执行：${tool.label}` : "处理中";
    }
    if (!this.diagnosisComplete) {
      return `判读波形与画面：已标记 ${this.project.diagnostics.length}/${this.sample.damage.length}`;
    }
    if (this.missingTools.length) {
      const tool = getTool(this.missingTools[0]);
      return `选择修复工序：${tool.label}`;
    }
    return "执行归档校验";
  }

  startRepair(toolId, rawValue) {
    const tool = getTool(toolId);
    if (!tool) return { ok: false, code: "UNKNOWN_TOOL" };
    if (this.project.state === "failed") return { ok: false, code: "IN_FAILED_STATE" };
    if (this.project.state === "archived") {
      return { ok: false, code: "ALREADY_ARCHIVED" };
    }
    if (
      this.project.state === "repairing" ||
      this.project.state === "paused"
    ) {
      return { ok: false, code: "BUSY" };
    }

    const value = Number(rawValue);
    this._snapshot(`${tool.label}前`);
    this._log("startRepair", { toolId, value });

    if (!this.diagnosisComplete) {
      return this._fail(
        "DIAGNOSIS_REQUIRED",
        "工序被锁定",
        "尚未完成损伤判读，不能直接修复"
      );
    }
    if (!this.sample.damage.includes(tool.damage)) {
      return this._fail(
        "TOOL_MISMATCH",
        "修复工具不匹配",
        `该样本没有需要「${tool.label}」处理的损伤`
      );
    }
    if (this.project.repairs[toolId]) {
      return this._fail(
        "ALREADY_REPAIRED",
        "重复处理",
        `${tool.label} 已执行，重复处理会破坏派生素材`
      );
    }
    if (tool.id === "align" && this.missingTools.some((id) => id !== "align")) {
      return this._fail(
        "ORDER_ERROR",
        "工序顺序错误",
        "时间对齐必须放在所有音频和画面修复之后"
      );
    }
    if (!Number.isFinite(value) || value < tool.min || value > tool.max) {
      return this._fail(
        "PARAM_LIMIT",
        "参数超出安全边界",
        `${tool.parameter}安全范围 ${tool.min}–${tool.max}${tool.unit}，当前 ${rawValue}${tool.unit}`
      );
    }
    if (this.resources.cpu < tool.costCpu) {
      return this._fail(
        "CPU_LIMIT",
        "算力不足",
        "回滚快照或释放当前工序所需缓存"
      );
    }
    if (this.resources.memory < tool.costMemory) {
      return this._fail(
        "MEMORY_LIMIT",
        "缓存不足",
        "当前修复片段无法装入工作缓存"
      );
    }

    this.project.playing = false;
    this.project.activeJob = {
      toolId,
      value,
      elapsed: 0,
      duration: tool.duration,
      progress: 0
    };
    this.project.state = "repairing";
    this._change(
      "REPAIR_START",
      "工序启动",
      `${tool.label} · ${tool.parameter} ${value}${tool.unit}`
    );
    return { ok: true, job: copy(this.project.activeJob) };
  }

  tick(step = FIXED_STEP) {
    if (this.project.state === "paused" || this.project.state === "archived") {
      return;
    }
    const delta = Math.max(0, Number(step) || 0);
    if (!delta) return;
    this.tickCount += 1;
    this.sessionSeconds = round(this.sessionSeconds + delta, 6);
    if (this.project.playing) {
      const duration = this.sample.duration;
      this.project.mediaPlayhead = round(
        (this.project.mediaPlayhead + delta) % duration,
        6
      );
    }
    if (this.project.state === "repairing" && this.project.activeJob) {
      const job = this.project.activeJob;
      job.elapsed = round(job.elapsed + delta, 6);
      job.progress = clamp(job.elapsed / job.duration, 0, 1);
      if (job.elapsed >= job.duration) this._completeJob();
    }
  }

  advanceTo(targetTick) {
    const target = Math.max(0, Math.floor(targetTick));
    while (this.tickCount < target) {
      const before = this.tickCount;
      this.tick(FIXED_STEP);
      if (this.tickCount === before) break;
    }
  }

  _scoreTool(tool, value) {
    const ideal =
      tool.id === "align" ? this.sample.driftMs : tool.ideal;
    const spread =
      tool.id === "align"
        ? 0.38
        : tool.id === "interpolate"
          ? 5.5
          : 0.72;
    const jitter = this.random() * 2.2 - 1.1;
    return clamp(Math.round((95 - Math.abs(value - ideal) * spread + jitter) * 10) / 10, 0, 99);
  }

  _recalculateMetrics() {
    const project = this.project;
    const score = (id) => project.repairs[id]?.score ?? 0;
    const videoTools = requiredTools(this.sample).filter(
      (tool) => tool.domain === "video"
    );
    const videoScores = videoTools.map((tool) => score(tool.id));
    if (videoTools.length === 0) project.metrics.video = 86;
    if (videoTools.length > 0) {
      const present = videoScores.filter((value) => value > 0);
      const missingPenalty = (videoTools.length - present.length) * 22;
      project.metrics.video =
        present.length === 0
          ? initialMetrics(this.sample).video
          : clamp(
              Math.round(
                present.reduce((sum, item) => sum + item, 0) / present.length -
                  missingPenalty
              ),
              0,
              99
            );
    }
    project.metrics.audio = this.sample.damage.includes("hum")
      ? project.repairs.denoise?.score ?? initialMetrics(this.sample).audio
      : 84;
    project.metrics.sync = this.sample.damage.includes("drift")
      ? project.repairs.align?.score ?? initialMetrics(this.sample).sync
      : 86;
  }

  _completeJob() {
    const job = this.project.activeJob;
    if (!job) return;
    const tool = getTool(job.toolId);
    const jobDuration = round(job.elapsed, 3);
    this.resources.cpu = clamp(this.resources.cpu - tool.costCpu, 0, 999);
    this.resources.memory = clamp(
      this.resources.memory - tool.costMemory,
      0,
      999
    );
    const score = this._scoreTool(tool, job.value);
    this.project.repairs[tool.id] = {
      toolId: tool.id,
      label: tool.label,
      value: job.value,
      unit: tool.unit,
      score,
      at: round(this.sessionSeconds, 3),
      duration: jobDuration,
      cpu: tool.costCpu,
      memory: tool.costMemory
    };
    this.project.activeJob = null;
    this._recalculateMetrics();
    const complete = this.missingTools.length === 0;
    this.project.state = complete ? "ready" : "inspect";
    this._change(
      complete ? "REPAIR_COMPLETE" : "STEP_COMPLETE",
      complete ? "修复序列完成" : "工序完成",
      `${tool.label} · 质量 ${score}% · 音 ${this.project.metrics.audio} / 画 ${this.project.metrics.video} / 同步 ${this.project.metrics.sync}`
    );
  }

  pauseSession() {
    if (this.project.state !== "repairing") {
      return { ok: false, code: "NOT_RUNNING" };
    }
    this.project.state = "paused";
    this.project.playing = false;
    this._change("PAUSED", "处理暂停", "当前工序进度与随机序列已冻结");
    this._log("pauseSession");
    return { ok: true };
  }

  resumeSession() {
    if (this.project.state !== "paused") {
      return { ok: false, code: "NOT_PAUSED" };
    }
    this.project.state = "repairing";
    this._change("RESUMED", "处理恢复", "继续执行冻结的修复工序");
    this._log("resumeSession");
    return { ok: true };
  }

  playMedia() {
    if (this.project.state === "archived" || this.project.state === "failed") {
      return { ok: false, code: "INVALID_STATE" };
    }
    this.project.playing = true;
    this._change("PLAYBACK", "开始回放", "预览音画时间轴");
    this._log("playMedia");
    return { ok: true };
  }

  pauseMedia() {
    if (!this.project.playing) return { ok: false, code: "NOT_PLAYING" };
    this.project.playing = false;
    this._change("PLAYBACK_PAUSE", "回放暂停", "预览停在当前帧");
    this._log("pauseMedia");
    return { ok: true };
  }

  seekMedia(seconds) {
    this.project.mediaPlayhead = clamp(
      round(Number(seconds) || 0, 6),
      0,
      this.sample.duration
    );
    this._change(
      "SEEK",
      "定位时间轴",
      `${this.project.mediaPlayhead.toFixed(2)}s`
    );
    this._log("seekMedia", { seconds: this.project.mediaPlayhead });
    return { ok: true };
  }

  undo() {
    if (this.project.state === "failed") return this.recover();
    if (!this.snapshots.length) {
      return { ok: false, code: "NO_SNAPSHOT" };
    }
    const snapshot = this.snapshots.pop();
    this._restore(snapshot);
    this.project.state =
      this.missingTools.length === 0 ? "ready" : "inspect";
    this._change(
      "UNDO",
      "已撤销",
      `恢复快照：${snapshot.label}`
    );
    this._log("undo");
    return { ok: true, label: snapshot.label };
  }

  recover() {
    if (this.project.state !== "failed") {
      return { ok: false, code: "NOT_FAILED" };
    }
    const snapshot = this.snapshots.pop();
    if (!snapshot) return { ok: false, code: "NO_SNAPSHOT" };
    this._restore(snapshot);
    this.project.state =
      this.missingTools.length === 0 ? "ready" : "inspect";
    this.project.error = null;
    this._change(
      "RECOVERED",
      "故障已恢复",
      `已回滚到「${snapshot.label}」，原始素材校验未变`
    );
    this._log("recover");
    return { ok: true, label: snapshot.label };
  }

  get verification() {
    const sample = this.sample;
    const metrics = this.project.metrics;
    const liveSourceHash = hashString(stableStringify(sample));
    const checks = [
      {
        id: "sequence",
        label: "修复链完整",
        pass: this.missingTools.length === 0,
        value: `${this.requiredTools.length - this.missingTools.length}/${this.requiredTools.length}`
      },
      {
        id: "audio",
        label: "音轨质量",
        pass:
          !sample.damage.includes("hum") || metrics.audio >= 80,
        value: `${metrics.audio}%`
      },
      {
        id: "video",
        label: "画面质量",
        pass:
          !sample.damage.some((id) => id === "drop" || id === "grain") ||
          metrics.video >= 80,
        value: `${metrics.video}%`
      },
      {
        id: "sync",
        label: "音画同步",
        pass: !sample.damage.includes("drift") || metrics.sync >= 80,
        value: `${metrics.sync}%`
      },
      {
        id: "source",
        label: "原始素材未变",
        pass: liveSourceHash === SOURCE_HASHES[sample.id],
        value: `sha:${liveSourceHash.slice(0, 8)}`
      }
    ];
    return {
      pass: checks.every((check) => check.pass),
      checks,
      metrics: copy(metrics)
    };
  }

  _fragment(kind, label, tools, searchText) {
    const sample = this.sample;
    const suffix =
      kind === "audio" ? "AUD" : kind === "video" ? "VID" : "SYN";
    const fragmentId = `${sample.code}-${suffix}`;
    return {
      fragmentId,
      kind,
      label,
      sampleId: sample.id,
      sampleCode: sample.code,
      title: sample.title,
      timecode: `00:00:00–${this._durationTimecode()}`,
      tools: tools.map((id) => getTool(id)?.label || id),
      tags: [...sample.tags, kind, "已修复"],
      searchText: [
        sample.code,
        sample.title,
        sample.subtitle,
        ...sample.tags,
        kind,
        label,
        ...tools.map((id) => getTool(id)?.short || id)
      ].join(" "),
      sourceHash: SOURCE_HASHES[sample.id],
      repairHash: hashString(
        stableStringify({
          sample: sample.id,
          kind,
          tools,
          repairs: tools.map((id) => this.project.repairs[id])
        })
      ),
      note: searchText
    };
  }

  _durationTimecode() {
    const whole = Math.floor(this.sample.duration);
    const mm = String(Math.floor(whole / 60)).padStart(2, "0");
    const ss = String(whole % 60).padStart(2, "0");
    return `00:${mm}:${ss}`;
  }

  archive() {
    if (this.project.state !== "ready") {
      return { ok: false, code: "NOT_READY" };
    }
    this._snapshot("归档校验前");
    if (!this.verification.pass) {
      this._log("archive");
      return this._fail(
        "VERIFY_FAILED",
        "归档校验失败",
        "至少一项质量指标未达标，请回滚后调整修复参数",
        { integrityCost: 0 }
      );
    }
    const sample = this.sample;
    const audioTools = this.requiredTools.filter(
      (id) => getTool(id).domain === "audio"
    );
    const videoTools = this.requiredTools.filter(
      (id) => getTool(id).domain === "video"
    );
    const syncTools = this.requiredTools.filter(
      (id) => getTool(id).domain === "sync"
    );
    const fragments = [];
    if (audioTools.length) {
      fragments.push(
        this._fragment(
          "audio",
          "修复音轨",
          audioTools,
          "可检索音轨 去噪 声场"
        )
      );
    }
    if (videoTools.length) {
      fragments.push(
        this._fragment(
          "video",
          "重建影像",
          videoTools,
          "可检索影像 补帧 降噪 画面"
        )
      );
    }
    if (syncTools.length) {
      fragments.push(
        this._fragment(
          "sync",
          "同步母版",
          syncTools,
          "可检索母版 时间对齐 音画同步"
        )
      );
    }
    const summary = {
      archiveId: `ARC-${sample.code}-${String(this.seed).padStart(5, "0")}`,
      sampleId: sample.id,
      title: sample.title,
      code: sample.code,
      incident: sample.incident,
      evidence: sample.evidence,
      archivedAt: archiveStamp(this.seed),
      seed: this.seed,
      sessionSeconds: round(this.sessionSeconds, 3),
      duration: sample.duration,
      diagnostics: [...this.project.diagnostics],
      repairs: copy(this.project.repairs),
      metrics: copy(this.project.metrics),
      resources: copy(this.resources),
      sourceHash: SOURCE_HASHES[sample.id],
      fragments,
      chainOfCustody: [
        "原始素材以只读方式载入，未发生覆写",
        "所有修复均在派生副本上执行",
        "每一步修复前生成可恢复快照",
        "最终索引引用修复片段哈希"
      ]
    };
    this.project.summary = summary;
    this.archives.unshift({ summary, fragments: copy(fragments) });
    this.project.state = "archived";
    this.project.playing = false;
    this.project.mediaPlayhead = 0;
    this.project.activeJob = null;
    this.project.verification = this.verification;
    this._change(
      "ARCHIVED",
      "档案已保存",
      `${summary.archiveId} · 已生成 ${fragments.length} 个可检索修复片段`
    );
    this._log("archive", { archiveId: summary.archiveId });
    this.finalStateHash = this.getStateHash();
    return { ok: true, summary: copy(summary), stateHash: this.finalStateHash };
  }

  search(query) {
    const needle = String(query || "").trim().toLowerCase();
    const fragments = this.archives.flatMap((entry) => entry.fragments);
    if (!needle) return copy(fragments);
    return copy(
      fragments.filter((fragment) =>
        [
          fragment.fragmentId,
          fragment.title,
          fragment.label,
          fragment.timecode,
          fragment.searchText,
          fragment.note,
          ...fragment.tags
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
    );
  }

  exportBundle() {
    return {
      schema: "signal-restoration-index/v1",
      generatedAt: archiveStamp(this.seed),
      seed: this.seed,
      archiveCount: this.archives.length,
      fragmentCount: this.archives.reduce(
        (sum, entry) => sum + entry.fragments.length,
        0
      ),
      entries: copy(this.archives),
      fragments: copy(this.archives.flatMap((entry) => entry.fragments)),
      integrity: {
        sourceHashes: copy(SOURCE_HASHES),
        finalStateHash: this.finalStateHash,
        deterministic: this.replayResult?.match ?? null
      }
    };
  }

  getStateHash() {
    const project = this.project;
    const payload = {
      schema: "restoration-state/v1",
      seed: this.seed,
      selectedId: this.selectedId,
      rngState: this.rngState,
      tickCount: this.tickCount,
      sessionSeconds: round(this.sessionSeconds, 5),
      resources: this.resources,
      mutationCount: this.mutationCount,
      project: {
        state: project.state,
        diagnostics: [...project.diagnostics].sort(),
        repairs: project.repairs,
        metrics: project.metrics,
        mediaPlayhead: round(project.mediaPlayhead, 5),
        playing: project.playing,
        activeJob: project.activeJob,
        error: project.error,
        verification: project.verification,
        summary: project.summary,
        lastChange: project.lastChange
      },
      archives: this.archives
    };
    return hashString(stableStringify(payload));
  }

  getRunRecord() {
    return {
      schema: "restoration-run/v1",
      seed: this.seed,
      sampleId: this.selectedId,
      finalTick: this.tickCount,
      fixedStep: FIXED_STEP,
      commands: copy(this.commandLog),
      stateHash: this.finalStateHash || this.getStateHash()
    };
  }

  static replay(record) {
    if (!record || !Array.isArray(record.commands)) {
      throw new Error("Invalid run record");
    }
    const engine = new RestorationEngine({
      seed: record.seed,
      selectedId: record.sampleId
    });
    for (const command of record.commands) {
      engine.advanceTo(command.tick);
      switch (command.type) {
        case "selectSample":
          engine.selectSample(command.sampleId);
          break;
        case "diagnose":
          engine.diagnose(command.damageId);
          break;
        case "startRepair":
          engine.startRepair(command.toolId, command.value);
          break;
        case "pauseSession":
          engine.pauseSession();
          break;
        case "resumeSession":
          engine.resumeSession();
          break;
        case "playMedia":
          engine.playMedia();
          break;
        case "pauseMedia":
          engine.pauseMedia();
          break;
        case "seekMedia":
          engine.seekMedia(command.seconds);
          break;
        case "undo":
          engine.undo();
          break;
        case "recover":
          engine.recover();
          break;
        case "archive":
          engine.archive();
          break;
        default:
          break;
      }
    }
    engine.advanceTo(record.finalTick);
    return engine;
  }
}

export const APP_CONSTANTS = Object.freeze({
  fixedStep: FIXED_STEP,
  initialResources: INITIAL_RESOURCES,
  sourceHashes: SOURCE_HASHES
});
