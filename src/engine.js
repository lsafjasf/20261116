export const TICK_MS = 100;
export const SLOT_COUNT = 4;

export const ROLES = {
  dispatcher: { id: "dispatcher", name: "码头调度员", short: "调度" },
  owner: { id: "owner", name: "货主", short: "货主" },
};

export const MODES = {
  escort: {
    id: "escort",
    name: "紧急引航",
    short: "紧急",
    detail: "最快 10 秒窗口 · 2 协商点",
    baseCost: 2,
    ticks: 100,
    credit: 0,
  },
  standard: {
    id: "standard",
    name: "标准优先",
    short: "标准",
    detail: "稳健 15 秒窗口 · 1 协商点",
    baseCost: 1,
    ticks: 150,
    credit: 0,
  },
  saver: {
    id: "saver",
    name: "错峰候补",
    short: "错峰",
    detail: "22 秒窗口 · 0 协商点 · 顺装 +2 信用",
    baseCost: 0,
    ticks: 220,
    credit: 2,
  },
};

export const STATE = Object.freeze({
  READY: "ready",
  REQUESTING: "requesting",
  RESPONDING: "responding",
  WON: "won",
  LOST: "lost",
});

const CARGO_BLUEPRINTS = [
  { id: "med", code: "M", name: "冷链药品", tone: "#48c9b0" },
  { id: "chip", code: "C", name: "精密芯片", tone: "#7aa7ff" },
  { id: "food", code: "F", name: "生鲜柜", tone: "#ffbd59" },
  { id: "relief", code: "R", name: "救援物资", tone: "#ff7b72" },
];

const LIMITS = {
  credit: 60,
  negotiation: 14,
  maxHistory: 40,
};

function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function seedToUint32(seed) {
  const text = String(seed ?? "640");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return mix32(hash);
}

export class Prng {
  constructor(seed) {
    this.state = seedToUint32(seed);
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  clone() {
    const copy = new Prng(0);
    copy.state = this.state;
    return copy;
  }
}

function shuffle(items, rng) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashState(value) {
  const text = canonicalize(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class Game {
  constructor(seed = "PORT-640", options = {}) {
    this.seed = String(seed);
    this.tickMs = options.tickMs ?? TICK_MS;
    this._safeCheckpoint = null;
    this.lastRestoreInfo = null;
    this.reset();
  }

  reset() {
    const rng = new Prng(this.seed);
    const ranked = shuffle(CARGO_BLUEPRINTS, rng).map((cargo, index) => ({
      ...cargo,
      rank: index + 1,
      loaded: false,
      loadedSlot: null,
    }));
    const randomForecast = Array.from({ length: 8 }, () => rng.int(1, 9));
    this._rng = rng;
    this._safeCheckpoint = null;
    this.lastRestoreInfo = null;
    this.state = {
      version: 1,
      seed: this.seed,
      status: STATE.READY,
      paused: false,
      tick: 0,
      activeRole: "dispatcher",
      cargos: ranked,
      loaded: [],
      slots: Array.from({ length: SLOT_COUNT }, () => null),
      current: null,
      credit: LIMITS.credit,
      negotiation: LIMITS.negotiation,
      refusalLevel: 0,
      rngState: rng.state,
      randomForecast,
      stats: { delays: 0, timeouts: 0, loads: 0, wrongOrder: 0 },
      outcome: null,
      history: [],
      inputs: [],
      lastChange: { tick: 0, kind: "boot", text: "港区系统就绪，等待双人接管。" },
    };
    return this;
  }

  start() {
    if (this.state.status !== STATE.READY) return { ok: false, reason: "ALREADY_STARTED" };
    this.state.status = STATE.REQUESTING;
    this._setChange("ready", `协商开始：${this.roleName()}先提出首项优先权请求。`);
    this._saveCheckpoint();
    return { ok: true };
  }

  restart() {
    this.reset();
    this.start();
    return { ok: true, hash: this.hash() };
  }

  get cargoById() {
    return new Map(this.state.cargos.map((cargo) => [cargo.id, cargo]));
  }

  roleName(role = this.state.activeRole) {
    return ROLES[role]?.name ?? role;
  }

  responderRole() {
    return this.state.activeRole === "dispatcher" ? "owner" : "dispatcher";
  }

  nextNegotiationCost(modeId = "escort") {
    return MODES[modeId].baseCost + this.state.refusalLevel;
  }

  currentGoal() {
    const { status, current, activeRole } = this.state;
    if (status === STATE.READY) return "双人接管共享仪表，准备协商装船顺序。";
    if (status === STATE.REQUESTING) {
      return `${this.roleName(activeRole)}：选择未装货物与优先权，向${this.roleName(this.responderRole())}发请求。`;
    }
    if (status === STATE.RESPONDING && current) {
      const cargo = this.cargoById.get(current.cargoId);
      const mode = MODES[current.modeId];
      return `${this.roleName(this.responderRole())}：对「${cargo.name} / ${mode.name}」接受或延迟。`;
    }
    if (status === STATE.WON) return "四票货物已装船，港口信用保持为正。";
    if (status === STATE.LOST) return "装船失败，检查失误并恢复最近安全检查点。";
    return "等待操作。";
  }

  phaseLabel() {
    if (this.state.paused) return "已暂停";
    return {
      ready: "待接管",
      requesting: "提出请求",
      responding: "等待回应",
      won: "装船完成",
      lost: "流程失败",
    }[this.state.status];
  }

  randomPreview(count = 8) {
    const rng = this._rng.clone();
    return Array.from({ length: clampInteger(count, 0, 64) }, () => rng.int(1, 9));
  }

  hash() {
    return hashState(this.state);
  }

  checkpointInfo() {
    if (!this._safeCheckpoint) return null;
    const snapshot = this._safeCheckpoint.state;
    return {
      tick: snapshot.tick,
      loaded: snapshot.loaded.length,
      credit: snapshot.credit,
      hash: hashState(snapshot),
    };
  }

  _setChange(kind, text) {
    this.state.lastChange = { tick: this.state.tick, kind, text };
    this.state.history.push({ tick: this.state.tick, kind, text });
    if (this.state.history.length > LIMITS.maxHistory) this.state.history.shift();
  }

  _record(action, payload = {}) {
    this.state.inputs.push({ atTick: this.state.tick, action, ...payload });
  }

  _syncRandom() {
    this.state.rngState = this._rng.state;
  }

  _saveCheckpoint() {
    this._safeCheckpoint = { state: clone(this.state) };
  }

  restoreCheckpoint() {
    if (!this._safeCheckpoint) return { ok: false, reason: "NO_CHECKPOINT" };
    const target = this._safeCheckpoint.state;
    this.state = clone(target);
    this._rng = new Prng(0);
    this._rng.state = this.state.rngState >>> 0;
    this.state.paused = false;
    this._record("restore");
    this._setChange("recovered", `已恢复至第 ${target.tick} tick 的安全检查点。`);
    this.lastRestoreInfo = { fromTick: target.tick, at: target.tick };
    return { ok: true, tick: target.tick, hash: this.hash() };
  }

  setPaused(paused) {
    if ([STATE.WON, STATE.LOST].includes(this.state.status)) return false;
    const next = Boolean(paused);
    if (this.state.paused === next) return false;
    this.state.paused = next;
    this._record("pause", { paused: next });
    this._setChange(next ? "paused" : "resumed", next ? "倒计时与协商已暂停。" : "倒计时与协商已继续。");
    return true;
  }

  togglePause() {
    return this.setPaused(!this.state.paused);
  }

  propose(cargoId, modeId) {
    if (this.state.paused) return { ok: false, reason: "PAUSED" };
    if (this.state.status !== STATE.REQUESTING) return { ok: false, reason: "NOT_REQUESTING" };
    const cargo = this.state.cargos.find((item) => item.id === cargoId);
    const mode = MODES[modeId];
    if (!cargo) return { ok: false, reason: "UNKNOWN_CARGO" };
    if (cargo.loaded) return { ok: false, reason: "CARGO_ALREADY_LOADED" };
    if (!mode) return { ok: false, reason: "UNKNOWN_MODE" };
    const cost = mode.baseCost + this.state.refusalLevel;
    if (this.state.negotiation < cost) return { ok: false, reason: "INSUFFICIENT_NEGOTIATION" };

    this.state.current = {
      cargoId,
      modeId,
      cost,
      startedAt: this.state.tick,
      expiresAt: this.state.tick + mode.ticks,
      ticks: mode.ticks,
    };
    this.state.status = STATE.RESPONDING;
    this._record("propose", { cargoId, modeId });
    this._setChange(
      "request",
      `${this.roleName()}请求「${cargo.name} / ${mode.name}」，成本 ${cost}。`,
    );
    return { ok: true, current: clone(this.state.current) };
  }

  respond(decision) {
    if (this.state.paused) return { ok: false, reason: "PAUSED" };
    if (this.state.status !== STATE.RESPONDING || !this.state.current) {
      return { ok: false, reason: "NO_ACTIVE_REQUEST" };
    }
    if (this.state.tick >= this.state.current.expiresAt) {
      this._timeout();
      return { ok: false, reason: "REQUEST_TIMED_OUT" };
    }
    if (!["accept", "delay"].includes(decision)) return { ok: false, reason: "BAD_DECISION" };

    const proposal = clone(this.state.current);
    this._record("respond", { decision });
    if (decision === "delay") {
      this.state.current = null;
      this.state.status = STATE.REQUESTING;
      this.state.refusalLevel += 1;
      this.state.stats.delays += 1;
      this.state.credit = Math.max(0, this.state.credit - 3);
      this._setChange(
        "delay",
        `${this.roleName(this.responderRole())}延迟请求：信用 -3，下次协商成本 +1。`,
      );
      this._evaluateOutcome();
      return { ok: true, decision, credit: this.state.credit };
    }

    if (this.state.negotiation < proposal.cost) {
      return { ok: false, reason: "INSUFFICIENT_NEGOTIATION" };
    }
    this.state.negotiation -= proposal.cost;
    this._acceptProposal(proposal);
    return { ok: true, decision, status: this.state.status };
  }

  _acceptProposal(proposal) {
    const cargo = this.state.cargos.find((item) => item.id === proposal.cargoId);
    const mode = MODES[proposal.modeId];
    const remaining = this.state.cargos.filter((item) => !item.loaded);
    const expectedRank = Math.min(...remaining.map((item) => item.rank));
    const slot = this.state.loaded.length;
    const wrongOrder = cargo.rank !== expectedRank;

    cargo.loaded = true;
    cargo.loadedSlot = slot + 1;
    this.state.loaded.push(cargo.id);
    this.state.slots[slot] = cargo.id;
    this.state.stats.loads += 1;
    this.state.current = null;
    this.state.status = STATE.REQUESTING;

    let creditDelta = 0;
    if (wrongOrder) {
      this.state.stats.wrongOrder += 1;
      creditDelta -= 12;
    } else if (mode.credit) {
      creditDelta += mode.credit;
    }

    const roll = this._rng.int(0, 99);
    this._syncRandom();
    let tideText = "潮汐平稳，无额外损益。";
    if (roll < 25) {
      creditDelta += 2;
      tideText = "顺潮到港：信用 +2。";
    } else if (roll < 40) {
      creditDelta -= 1;
      tideText = "航道拥挤：信用 -1。";
    }
    this.state.credit = Math.max(0, this.state.credit + creditDelta);

    const orderText = wrongOrder
      ? `顺序失误（应先装 P${expectedRank}）：信用 -12。`
      : `顺序正确（P${cargo.rank}）：${mode.credit ? `错峰信用 +${mode.credit}。` : "信用无损。"}`;
    this.state.activeRole = this.responderRole();
    this._setChange(
      "loaded",
      `${cargo.name} 已装入 ${slot + 1} 号货位。${orderText}${tideText}`,
    );
    this._evaluateOutcome();
    if (!wrongOrder && this.state.status !== STATE.LOST) this._saveCheckpoint();
  }

  tick(deltaTicks = 1) {
    if (this.state.paused) return false;
    if (!Number.isFinite(deltaTicks) || deltaTicks <= 0) return false;
    if (![STATE.REQUESTING, STATE.RESPONDING].includes(this.state.status)) return false;
    const amount = clampInteger(deltaTicks, 1, 100000);
    this.state.tick += amount;
    if (
      this.state.status === STATE.RESPONDING &&
      this.state.current &&
      this.state.tick >= this.state.current.expiresAt
    ) {
      this._timeout();
    }
    return true;
  }

  _timeout() {
    const proposal = this.state.current;
    const cargo = proposal ? this.state.cargos.find((item) => item.id === proposal.cargoId) : null;
    this.state.current = null;
    this.state.status = STATE.REQUESTING;
    this.state.stats.timeouts += 1;
    this.state.credit = Math.max(0, this.state.credit - 10);
    this._setChange(
      "timeout",
      `请求超时：${cargo?.name ?? "货物"} 未装船，港口信用 -10。`,
    );
    this._evaluateOutcome();
  }

  _evaluateOutcome() {
    if (this.state.credit <= 0) {
      this.state.status = STATE.LOST;
      this.state.outcome = {
        kind: "credit",
        text: "港口信用耗尽，装船流程失败。",
      };
      this._setChange("lost", this.state.outcome.text);
      return;
    }
    if (this.state.loaded.length === SLOT_COUNT) {
      this.state.status = STATE.WON;
      this.state.outcome = {
        kind: "success",
        text: `四票货物全部装船，剩余信用 ${this.state.credit}。`,
      };
      this._setChange("won", this.state.outcome.text);
      return;
    }
    if (this.state.negotiation < this.state.refusalLevel) {
      this.state.status = STATE.LOST;
      this.state.outcome = {
        kind: "negotiation",
        text: "协商成本已超过剩余协商点，无法继续发请求。",
      };
      this._setChange("lost", this.state.outcome.text);
    }
  }

  toRecord() {
    return {
      version: 1,
      seed: this.seed,
      tickMs: this.tickMs,
      finalTick: this.state.tick,
      finalHash: this.hash(),
      inputs: clone(this.state.inputs),
      result: {
        status: this.state.status,
        credit: this.state.credit,
        loaded: clone(this.state.loaded),
        stats: clone(this.state.stats),
      },
    };
  }
}

export function replayRecord(record) {
  if (!record || record.version !== 1) throw new Error("Unsupported record version");
  const game = new Game(record.seed, { tickMs: record.tickMs });
  game.start();
  for (const input of record.inputs ?? []) {
    const targetTick = Number.isFinite(input.atTick) ? input.atTick : game.state.tick;
    if (targetTick > game.state.tick) game.tick(targetTick - game.state.tick);
    if (input.action === "propose") {
      game.propose(input.cargoId, input.modeId);
    } else if (input.action === "respond") {
      game.respond(input.decision);
    } else if (input.action === "restore") {
      game.restoreCheckpoint();
    } else if (input.action === "pause") {
      game.setPaused(input.paused);
    }
  }
  if (record.finalTick > game.state.tick) game.tick(record.finalTick - game.state.tick);
  const finalHash = game.hash();
  return {
    game,
    finalHash,
    matches: finalHash === record.finalHash && game.state.tick === record.finalTick,
  };
}
