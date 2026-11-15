// 程序化视频播放器核心：确定性时间线 + 可注入时钟 + 两种调度模式。
// legacy: 复现竞态缺陷（无序提交、暂停拖动自动推进）。
// fixed:  请求序列号 + 取消标记 + 最新帧优先；音频/字幕随最终帧原子提交。

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 公开数据语义（两种模式共用，保证视觉/数据语义不变） ----

export function frameData(index) {
  return { index, hue: (index * 7) % 360, label: `FRAME-${index}` };
}

export function subtitleAt(sec) {
  const i = Math.max(0, Math.floor(sec));
  return `字幕#${i} "台词-${i}"`;
}

export function formatTimecode(sec, fps) {
  const frames = Math.round(Math.max(0, sec) * fps);
  const s = Math.floor(frames / fps);
  const ff = frames % fps;
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}.${String(ff).padStart(2, '0')}`;
}

// ---- 虚拟时钟（场景复现用；浏览器中注入真实时钟） ----

export class VirtualClock {
  constructor() { this.t = 0; this.queue = []; this.nextId = 1; }
  now() { return this.t; }
  setTimeout(fn, delay) {
    const id = this.nextId++;
    this.queue.push({ at: this.t + Math.max(0, delay), fn, id });
    this.queue.sort((a, b) => a.at - b.at || a.id - b.id);
    return id;
  }
  clearTimeout(id) { this.queue = this.queue.filter((e) => e.id !== id); }
  advance(ms) {
    const end = this.t + ms;
    let guard = 0;
    while (this.queue.length && this.queue[0].at <= end && guard++ < 1e6) {
      const e = this.queue.shift(); this.t = e.at; e.fn();
    }
    this.t = end;
  }
  settle() {
    let guard = 0;
    while (this.queue.length && guard++ < 1e6) {
      const e = this.queue.shift(); this.t = e.at; e.fn();
    }
  }
}

// ---- 播放器核心 ----

export class PlayerCore {
  constructor(opts = {}) {
    this.mode = opts.mode || 'fixed'; // 'legacy' | 'fixed'
    this.fps = opts.fps ?? 30;
    this.frameCount = opts.frameCount ?? 900; // 30s
    this.cacheSize = opts.cacheSize ?? 24;
    this.clock = opts.clock;
    this.latencyProfile = opts.latencyProfile || 'normal'; // normal|zero|spiky
    this.rand = mulberry32(opts.seed ?? 1234);
    this.cache = new Map(); // LRU: index -> frameData
    this.playing = false;
    this.time = 0;          // 已提交的媒体时间（权威）
    this.audioTime = 0;     // 可观测音频位置
    this.frame = frameData(0);
    this.subtitle = subtitleAt(0);
    this.latestSeq = 0;                 // 请求序列号（fixed）
    this.requests = new Map();          // seq -> { cancelled }（fixed）
    this._issueSeq = 0;                 // 发出序号（legacy 检测用，不影响行为）
    this.inflight = 0;
    this.metrics = {
      candidates: 0, dropped: 0, applied: 0, decodes: 0,
      cacheHits: 0, cacheMisses: 0,
      lastFrameMs: 0, totalFrameMs: 0, maxFrameMs: 0,
    };
    this.anomalies = [];
    this.oncommit = opts.oncommit || null;
    this._tickId = null;
  }

  get duration() { return this.frameCount / this.fps; }
  get timecode() { return formatTimecode(this.time, this.fps); }
  get cacheNodes() { return this.cache.size; }
  get cacheHitRate() {
    const total = this.metrics.cacheHits + this.metrics.cacheMisses;
    return total ? this.metrics.cacheHits / total : 0;
  }
  get avgFrameMs() {
    return this.metrics.decodes ? this.metrics.totalFrameMs / this.metrics.decodes : 0;
  }

  clampTime(t) { return Math.min(this.duration, Math.max(0, t)); }
  frameIndexFor(t) { return Math.min(this.frameCount - 1, Math.round(t * this.fps)); }

  _latency() {
    if (this.latencyProfile === 'zero') return 0;
    const r = this.rand();
    if (this.latencyProfile === 'spiky') return r < 0.2 ? 120 + this.rand() * 80 : 5 + this.rand() * 20;
    return 5 + r * 55; // 5..60ms
  }

  // 唯一提交点：帧、时间码、音频、字幕原子更新
  _commit(index, t, issueSeq) {
    this.frame = frameData(index);
    this.time = t;
    this.audioTime = t;
    this.subtitle = subtitleAt(t);
    this.metrics.applied++;
    if (this.oncommit) this.oncommit(this, { index, t, issueSeq });
  }

  _decode(index, apply) {
    const hit = this.cache.get(index);
    if (hit !== undefined) {
      this.metrics.cacheHits++;
      this.cache.delete(index);
      this.cache.set(index, hit); // LRU 刷新
      apply(hit);
      return;
    }
    this.metrics.cacheMisses++;
    this.metrics.decodes++;
    this.inflight++;
    const t0 = this.clock.now();
    this.clock.setTimeout(() => {
      this.inflight--;
      const ms = this.clock.now() - t0;
      this.metrics.lastFrameMs = ms;
      this.metrics.totalFrameMs += ms;
      this.metrics.maxFrameMs = Math.max(this.metrics.maxFrameMs, ms);
      const data = frameData(index);
      this.cache.set(index, data);
      if (this.cache.size > this.cacheSize) {
        this.cache.delete(this.cache.keys().next().value); // 淘汰最旧节点
      }
      apply(data);
    }, this._latency());
  }

  seek(t) {
    const target = this.clampTime(t);
    this.metrics.candidates++;
    if (this.mode === 'legacy') {
      // 缺陷1：暂停下拖动会重新启动推进定时器
      this._ensureTicker();
      // 缺陷2：无序列号、无取消，解码完成即盲目提交 → 乱序覆盖
      const issue = ++this._issueSeq;
      this._decode(this.frameIndexFor(target), (data) => this._commit(data.index, target, issue));
      return;
    }
    // fixed：请求序列号 + 取消标记 + 最新帧优先
    const seq = ++this.latestSeq;
    for (const req of this.requests.values()) req.cancelled = true;
    const req = { seq, cancelled: false };
    this.requests.set(seq, req);
    this._decode(this.frameIndexFor(target), (data) => {
      if (req.cancelled || seq !== this.latestSeq) { this.metrics.dropped++; return; }
      this.requests.delete(seq);
      this._commit(data.index, target, seq); // 最终帧确定后，音频/字幕在此统一更新
    });
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._ensureTicker();
  }

  pause() {
    this.playing = false;
    if (this._tickId != null && this.mode === 'fixed') {
      this.clock.clearTimeout(this._tickId);
      this._tickId = null;
    }
  }

  _ensureTicker() {
    if (this._tickId != null) return;
    this._tickId = this.clock.setTimeout(() => this._tick(), 1000 / this.fps);
  }

  _tick() {
    this._tickId = null;
    if (this.mode === 'fixed' && !this.playing) return; // 暂停不推进
    const t = this.clampTime(this.time + 1 / this.fps);
    if (this.mode === 'legacy') {
      const issue = ++this._issueSeq;
      this._decode(this.frameIndexFor(t), (data) => this._commit(data.index, t, issue));
      if (t < this.duration) this._ensureTicker();
      return;
    }
    if (t >= this.duration) { this.playing = false; return; }
    // 播放推进与拖动共用同一序列管线，拖动可取消播放请求
    const seq = ++this.latestSeq;
    for (const req of this.requests.values()) req.cancelled = true;
    const req = { seq, cancelled: false };
    this.requests.set(seq, req);
    this._decode(this.frameIndexFor(t), (data) => {
      if (req.cancelled || seq !== this.latestSeq) { this.metrics.dropped++; return; }
      this.requests.delete(seq);
      this._commit(data.index, t, seq);
    });
    this._ensureTicker();
  }
}
