(function () {
  "use strict";

  const {
    MixEngine,
    defaultSettings,
    defaultTracks,
    dbToGain,
    clamp,
    round,
    formatPan,
    staticGainReductionDb,
  } = window.MIX04;

  const STORAGE_PROJECT = "mix04.project.v1";
  const STORAGE_SNAPSHOT = "mix04.snapshot.v1";
  const OVERLOAD_LINEAR = 0.955;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const sleep = (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const engine = new MixEngine({
    settings: defaultSettings(),
    onChange: (event) => {
      if (event === "error" && engine.lastError) {
        showToast(`音频引擎：${engine.lastError.message}`, "error");
      }
      syncTransport();
    },
  });

  const state = {
    snapshot: null,
    comparisonRunning: false,
    validationRunning: false,
    exportRunning: false,
    snapshotRunning: false,
    scrubbing: false,
    peakHold: new Map(),
    overloadUntil: new Map(),
    renderedComparison: null,
    lastFrame: 0,
    frameCount: 0,
  };

  const elements = {
    channels: $("#channels"),
    compressorControls: $("#compressor-controls"),
    compressorCurve: $("#compressor-curve"),
    compressorPoint: $("#compressor-point"),
    bypassButton: $("#compressor-bypass"),
    bypassState: $("#compressor-state"),
    playButton: $("#transport-play"),
    timeline: $("#timeline"),
    timelineFill: $("#timeline-fill"),
    timelineHead: $("#timeline-head"),
    transportTime: $("#transport-time"),
    sessionMapTime: $("#session-map-time"),
    beatReadout: $("#beat-readout"),
    globalStatus: $("#global-status"),
    globalStatusDot: $("#global-status-dot"),
    activeNodes: $("#active-nodes"),
    nodeDetail: $("#node-detail"),
    listenerCount: $("#listener-count"),
    contextState: $("#context-state"),
    sampleRate: $("#sample-rate"),
    schedulerState: $("#scheduler-state"),
    schedulerDetail: $("#scheduler-detail"),
    healthBadge: $("#health-badge"),
    chainState: $("#chain-state"),
    runtimeMessage: $("#runtime-message"),
    grFill: $("#gr-fill"),
    grReadout: $("#gr-readout"),
    sessionWave: $("#session-wave"),
    sessionBeats: $("#session-beats"),
    footerClock: $("#footer-clock"),
  };

  function showToast(message, type = "success") {
    const region = $("#toast-region");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    region.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add("leaving");
      window.setTimeout(() => toast.remove(), 220);
    }, 3800);
  }

  function setFooter(action) {
    const time = new Date().toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    elements.footerClock.textContent = `LAST ACTION ${action} — ${time}`;
  }

  function setText(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function progressFor(value, min, max) {
    return `${clamp(((value - min) / (max - min)) * 100, 0, 100)}%`;
  }

  function setRangeProgress(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    input.style.setProperty(
      "--range-progress",
      progressFor(Number(input.value), min, max),
    );
  }

  function formatSigned(value, digits = 1, suffix = "") {
    const number = Number(value);
    if (!Number.isFinite(number)) return `—${suffix}`;
    const prefix = number > 0 ? "+" : "";
    return `${prefix}${number.toFixed(digits)}${suffix}`;
  }

  function formatPeakDb(db) {
    if (!Number.isFinite(db)) return "−∞ dB";
    return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
  }

  function trackControlMarkup(track) {
    return `
      <article class="channel" id="channel-${track.id}" data-track="${track.id}" style="--channel-color: ${track.color}">
        <div class="channel-head">
          <span class="channel-number">${track.index}</span>
          <div class="channel-title">
            <h3>${track.name}</h3>
            <p>${track.en}</p>
          </div>
          <div class="channel-buttons">
            <button class="channel-button" type="button" data-action="mute" data-track="${track.id}" aria-label="${track.name}静音" title="静音">M</button>
            <button class="channel-button" type="button" data-action="solo" data-track="${track.id}" aria-label="${track.name}独奏试听" title="独奏试听（绕过总线压缩）">S</button>
          </div>
        </div>
        <div class="channel-display">
          <div class="channel-meter" aria-hidden="true">
            <span class="channel-meter-fill" data-meter-fill="${track.id}"></span>
            <i class="channel-peak-line" data-peak-line="${track.id}"></i>
          </div>
          <div class="scope" aria-hidden="true">
            <svg viewBox="0 0 120 78" preserveAspectRatio="none">
              <path class="scope-path" data-scope="${track.id}" d="M0 39 L120 39"></path>
            </svg>
          </div>
          <div class="peak-readout">
            <span class="peak-value" data-peak-value="${track.id}">−∞ dB</span>
            <span class="peak-badge">PEAK</span>
          </div>
        </div>
        <div class="channel-controls">
          <div class="control-block pan-block">
            <div class="control-label-row">
              <span class="control-label">PAN</span>
              <span class="control-value pan-value" data-value="pan-${track.id}">${formatPan(track.pan)}</span>
            </div>
            <input type="range" data-track="${track.id}" data-param="pan" min="-100" max="100" step="1" value="${Math.round(track.pan * 100)}" aria-label="${track.name}声像" />
          </div>
          <div class="control-block eq-stack">
            <div class="eq-row">
              <span class="control-label">LOW</span>
              <input type="range" data-track="${track.id}" data-eq="low" min="-12" max="12" step="0.5" value="${track.eq.low}" aria-label="${track.name}低频" />
              <span class="control-value" data-value="eq-low-${track.id}">${formatSigned(track.eq.low)}</span>
            </div>
            <div class="eq-row">
              <span class="control-label">MID</span>
              <input type="range" data-track="${track.id}" data-eq="mid" min="-12" max="12" step="0.5" value="${track.eq.mid}" aria-label="${track.name}中频" />
              <span class="control-value" data-value="eq-mid-${track.id}">${formatSigned(track.eq.mid)}</span>
            </div>
            <div class="eq-row">
              <span class="control-label">HIGH</span>
              <input type="range" data-track="${track.id}" data-eq="high" min="-12" max="12" step="0.5" value="${track.eq.high}" aria-label="${track.name}高频" />
              <span class="control-value" data-value="eq-high-${track.id}">${formatSigned(track.eq.high)}</span>
            </div>
          </div>
          <div class="control-block gain-block">
            <div class="control-label-row">
              <span class="control-label">GAIN</span>
              <span class="control-value" data-value="gain-${track.id}">${formatSigned(track.gainDb)} dB</span>
            </div>
          </div>
          <div class="fader-block">
            <div class="fader">
              <span class="fader-scale" aria-hidden="true">${Array.from({ length: 9 }, () => "<i></i>").join("")}</span>
              <input type="range" data-track="${track.id}" data-param="gain" min="-60" max="6" step="0.1" value="${track.gainDb}" aria-label="${track.name}音量" title="双击归零到默认值" />
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function buildChannels() {
    elements.channels.innerHTML = engine.settings.tracks
      .map(trackControlMarkup)
      .join("");
    $$("input[type=range]", elements.channels).forEach(setRangeProgress);
  }

  function compressorControlMarkup(config) {
    const controls = [
      {
        id: "threshold",
        label: "THRESHOLD",
        min: -60,
        max: 0,
        step: 0.5,
        value: config.threshold,
        format: (value) => `${Number(value).toFixed(1)} dB`,
      },
      {
        id: "ratio",
        label: "RATIO",
        min: 1,
        max: 20,
        step: 0.1,
        value: config.ratio,
        format: (value) => `${Number(value).toFixed(1)} : 1`,
      },
      {
        id: "attack",
        label: "ATTACK",
        min: 0.001,
        max: 0.2,
        step: 0.001,
        value: config.attack,
        format: (value) => `${Math.round(Number(value) * 1000)} ms`,
      },
      {
        id: "release",
        label: "RELEASE",
        min: 0.03,
        max: 1,
        step: 0.01,
        value: config.release,
        format: (value) => `${Math.round(Number(value) * 1000)} ms`,
      },
      {
        id: "makeup",
        label: "MAKEUP",
        min: 0,
        max: 12,
        step: 0.1,
        value: config.makeup,
        format: (value) => `+${Number(value).toFixed(1)} dB`,
      },
    ];
    return controls
      .map(
        (control) => `
          <div class="control-block compressor-control">
            <div class="control-label-row">
              <span class="control-label">${control.label}</span>
              <span class="control-value" data-compressor-value="${control.id}">${control.format(control.value)}</span>
            </div>
            <input type="range" data-compressor="${control.id}" min="${control.min}" max="${control.max}" step="${control.step}" value="${control.value}" aria-label="${control.label}" />
          </div>
        `,
      )
      .join("");
  }

  function buildCompressorControls() {
    elements.compressorControls.innerHTML = compressorControlMarkup(
      engine.settings.compressor,
    );
    $$("input[type=range]", elements.compressorControls).forEach(setRangeProgress);
  }

  function buildSessionVisual() {
    const points = 120;
    const top = [];
    const bottom = [];
    for (let index = 0; index <= points; index += 1) {
      const x = (index / points) * 400;
      const envelope =
        0.24 +
        Math.abs(Math.sin(index * 0.31)) * 0.35 +
        Math.abs(Math.sin(index * 0.083 + 0.6)) * 0.25;
      const transient = index % 11 === 0 ? 0.2 : 0;
      const amplitude = Math.min(0.88, envelope + transient) * 40;
      top.push(`${x.toFixed(1)} ${(47 - amplitude).toFixed(1)}`);
      bottom.push(`${x.toFixed(1)} ${(47 + amplitude * 0.72).toFixed(1)}`);
    }
    elements.sessionWave.innerHTML = `
      <svg viewBox="0 0 400 94" preserveAspectRatio="none" aria-hidden="true">
        <path d="M${top.join(" L")}" fill="none" stroke="#cdfc58" stroke-width="1" opacity=".9"></path>
        <path d="M${bottom.join(" L")}" fill="none" stroke="#cdfc58" stroke-width=".65" opacity=".44"></path>
        <line x1="0" y1="47" x2="400" y2="47" stroke="rgba(240,240,223,.13)" stroke-width=".5"></line>
      </svg>
    `;
    elements.sessionBeats.innerHTML = engine.beatPoints
      .map(
        (_, index) =>
          `<i class="${index % 4 === 0 ? "major" : ""}" data-beat="${index}"></i>`,
      )
      .join("");
    setText("session-bars", Math.ceil((engine.duration / engine.beatSeconds) / 4));
  }

  function updateTrackControlUI(track) {
    const channel = document.getElementById(`channel-${track.id}`);
    if (!channel) return;
    channel.classList.toggle("is-muted", track.mute);
    channel.classList.toggle("is-solo", track.solo);
    const mute = $('[data-action="mute"]', channel);
    const solo = $('[data-action="solo"]', channel);
    mute.classList.toggle("active-mute", track.mute);
    solo.classList.toggle("active-solo", track.solo);
    mute.setAttribute("aria-pressed", String(track.mute));
    solo.setAttribute("aria-pressed", String(track.solo));
    const gainInput = $('[data-param="gain"]', channel);
    const panInput = $('[data-param="pan"]', channel);
    gainInput.value = track.gainDb;
    panInput.value = Math.round(track.pan * 100);
    for (const band of ["low", "mid", "high"]) {
      const input = $(`[data-eq="${band}"]`, channel);
      input.value = track.eq[band];
      setRangeProgress(input);
    }
    setRangeProgress(gainInput);
    setRangeProgress(panInput);
    const gainLabel = $(`[data-value="gain-${track.id}"]`, channel);
    const panLabel = $(`[data-value="pan-${track.id}"]`, channel);
    if (gainLabel) gainLabel.textContent = `${formatSigned(track.gainDb)} dB`;
    if (panLabel) panLabel.textContent = formatPan(track.pan);
    for (const band of ["low", "mid", "high"]) {
      const label = $(`[data-value="eq-${band}-${track.id}"]`, channel);
      if (label) label.textContent = formatSigned(track.eq[band]);
    }
  }

  function compressorFormat(id, value) {
    if (id === "threshold") return `${Number(value).toFixed(1)} dB`;
    if (id === "ratio") return `${Number(value).toFixed(1)} : 1`;
    if (id === "attack") return `${Math.round(Number(value) * 1000)} ms`;
    if (id === "release") return `${Math.round(Number(value) * 1000)} ms`;
    return `+${Number(value).toFixed(1)} dB`;
  }

  function renderCompressorCurve() {
    const compressor = engine.settings.compressor;
    const coordinates = [];
    for (let step = 0; step <= 60; step += 1) {
      const inputDb = -60 + step;
      const reduction = compressor.enabled
        ? staticGainReductionDb(inputDb, compressor)
        : 0;
      const outputDb =
        inputDb + reduction + (compressor.enabled ? compressor.makeup : 0);
      const x = 20 + (step / 60) * 180;
      const y = 100 - clamp((outputDb + 60) / 60, 0, 1) * 80;
      coordinates.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    elements.compressorCurve.setAttribute("d", `M${coordinates.join(" L")}`);
    const thresholdX =
      20 +
      ((clamp(compressor.threshold, -60, 0) + 60) / 60) * 180;
    const thresholdReduction = compressor.enabled
      ? staticGainReductionDb(compressor.threshold, compressor)
      : 0;
    const thresholdOutput =
      compressor.threshold +
      thresholdReduction +
      (compressor.enabled ? compressor.makeup : 0);
    const thresholdY =
      100 - clamp((thresholdOutput + 60) / 60, 0, 1) * 80;
    elements.compressorPoint.setAttribute("cx", thresholdX.toFixed(1));
    elements.compressorPoint.setAttribute("cy", thresholdY.toFixed(1));
  }

  function updateCompressorUI() {
    const compressor = engine.settings.compressor;
    for (const input of $$("input[data-compressor]", elements.compressorControls)) {
      const id = input.dataset.compressor;
      input.value = compressor[id];
      setRangeProgress(input);
      const label = $(`[data-compressor-value="${id}"]`, elements.compressorControls);
      if (label) label.textContent = compressorFormat(id, compressor[id]);
    }
    elements.bypassButton.classList.toggle("is-bypassed", !compressor.enabled);
    elements.bypassButton.setAttribute(
      "aria-checked",
      String(!compressor.enabled),
    );
    elements.bypassState.textContent = compressor.enabled ? "ACTIVE" : "BYPASSED";
    renderCompressorCurve();
  }

  function syncAllControls() {
    engine.settings.tracks.forEach(updateTrackControlUI);
    updateCompressorUI();
    elements.timeline.value = engine.position;
    elements.timelineFill.style.width = `${(engine.position / engine.duration) * 100}%`;
    elements.timelineHead.style.left = `${(engine.position / engine.duration) * 100}%`;
    $("#loop-toggle").classList.toggle("active", engine.loop);
    syncTransport();
  }

  function normalizeSettings(raw) {
    const clean = defaultSettings();
    if (!raw || !Array.isArray(raw.tracks)) return clean;
    for (const track of clean.tracks) {
      const incoming = raw.tracks.find((candidate) => candidate.id === track.id);
      if (!incoming) continue;
      const finite = (value, fallback) =>
        Number.isFinite(Number(value)) ? Number(value) : fallback;
      track.gainDb = clamp(finite(incoming.gainDb, track.gainDb), -60, 6);
      track.pan = clamp(finite(incoming.pan, track.pan), -1, 1);
      track.eq.low = clamp(finite(incoming.eq && incoming.eq.low, track.eq.low), -12, 12);
      track.eq.mid = clamp(finite(incoming.eq && incoming.eq.mid, track.eq.mid), -12, 12);
      track.eq.high = clamp(finite(incoming.eq && incoming.eq.high, track.eq.high), -12, 12);
      track.mute = Boolean(incoming.mute);
      track.solo = Boolean(incoming.solo);
    }
    const compressor = raw.compressor || {};
    clean.compressor.enabled =
      typeof compressor.enabled === "boolean"
        ? compressor.enabled
        : clean.compressor.enabled;
    clean.compressor.threshold = clamp(
      Number(compressor.threshold ?? clean.compressor.threshold),
      -60,
      0,
    );
    clean.compressor.ratio = clamp(
      Number(compressor.ratio ?? clean.compressor.ratio),
      1,
      20,
    );
    clean.compressor.attack = clamp(
      Number(compressor.attack ?? clean.compressor.attack),
      0.001,
      0.2,
    );
    clean.compressor.release = clamp(
      Number(compressor.release ?? clean.compressor.release),
      0.03,
      1,
    );
    clean.compressor.makeup = clamp(
      Number(compressor.makeup ?? clean.compressor.makeup),
      0,
      12,
    );
    return clean;
  }

  function applySettings(settings, options = {}) {
    engine.stop();
    engine.settings = normalizeSettings(settings);
    engine.position = clamp(
      Number(options.position ?? engine.position) || 0,
      0,
      engine.duration,
    );
    if (typeof options.loop === "boolean") engine.loop = options.loop;
    syncAllControls();
    engine.notify("settings");
    setFooter("SETTINGS APPLIED");
  }

  function handleTrackInput(event) {
    const input = event.target.closest("input[type=range]");
    if (!input) return;
    const track = engine.getTrack(input.dataset.track);
    if (!track) return;
    setRangeProgress(input);
    if (input.dataset.param === "gain") {
      track.gainDb = Number(input.value);
      const label = $(`[data-value="gain-${track.id}"]`);
      if (label) label.textContent = `${formatSigned(track.gainDb)} dB`;
    } else if (input.dataset.param === "pan") {
      track.pan = Number(input.value) / 100;
      const label = $(`[data-value="pan-${track.id}"]`);
      if (label) label.textContent = formatPan(track.pan);
    } else if (input.dataset.eq) {
      const band = input.dataset.eq;
      track.eq[band] = Number(input.value);
      const label = $(`[data-value="eq-${band}-${track.id}"]`);
      if (label) label.textContent = formatSigned(track.eq[band]);
    }
    engine.applyTrackSettings(track.id);
    setFooter("CHANNEL EDIT");
  }

  function handleTrackClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const track = engine.getTrack(button.dataset.track);
    if (!track) return;
    if (button.dataset.action === "mute") track.mute = !track.mute;
    if (button.dataset.action === "solo") track.solo = !track.solo;
    updateTrackControlUI(track);
    engine.applyTrackSettings(track.id);
    engine.updateLiveRouting();
    setFooter(track.solo ? "SOLO PREVIEW" : "CHANNEL ROUTING");
  }

  function resetTrackVolume(event) {
    const input = event.target.closest('input[data-param="gain"]');
    if (!input) return;
    const track = engine.getTrack(input.dataset.track);
    const definition = defaultTracks().find((candidate) => candidate.id === track.id);
    if (!track || !definition) return;
    track.gainDb = definition.gainDb;
    updateTrackControlUI(track);
    engine.applyTrackSettings(track.id);
    setFooter("FADER RESET");
  }

  function handleCompressorInput(event) {
    const input = event.target.closest("input[data-compressor]");
    if (!input) return;
    const id = input.dataset.compressor;
    engine.settings.compressor[id] = Number(input.value);
    setRangeProgress(input);
    const label = $(`[data-compressor-value="${id}"]`);
    if (label) label.textContent = compressorFormat(id, input.value);
    engine.updateLiveCompressor();
    renderCompressorCurve();
    setFooter("BUS COMPRESSOR");
  }

  function syncTransport() {
    if (!elements.playButton) return;
    elements.playButton.classList.toggle("is-playing", engine.playing);
    elements.playButton.setAttribute(
      "aria-label",
      engine.playing ? "暂停并停止尾音" : "播放",
    );
    $("#loop-toggle").classList.toggle("active", engine.loop);
    if (!state.scrubbing) {
      const position = engine.getPosition();
      elements.transportTime.textContent = formatTime(position);
    }
  }

  function formatTime(seconds) {
    const bounded = clamp(Number(seconds) || 0, 0, 3600);
    const minutes = Math.floor(bounded / 60);
    const remainder = bounded - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${remainder
      .toFixed(1)
      .padStart(4, "0")}`;
  }

  async function toggleTransport() {
    try {
      if (engine.playing) {
        engine.pause();
        showToast("已暂停：所有源节点与尾音已清理。");
      } else {
        const result = await engine.start();
        if (!result.started && result.reason === "already-playing") {
          showToast("播放已在运行，未创建重复音频图。", "warning");
        }
      }
    } catch (error) {
      showToast(`无法启动音频：${error.message}`, "error");
    }
  }

  function updateMeters(now, frame) {
    for (const track of engine.settings.tracks) {
      const meter = engine.getTrackMeter(track.id);
      const channel = document.getElementById(`channel-${track.id}`);
      const fill = $(`[data-meter-fill="${track.id}"]`);
      const peakLine = $(`[data-peak-line="${track.id}"]`);
      const peakValue = $(`[data-peak-value="${track.id}"]`);
      const db = meter.peakDb;
      const percent = Number.isFinite(db)
        ? clamp(((db + 60) / 60) * 100, 0, 100)
        : 0;
      if (fill) fill.style.height = `${percent}%`;
      if (peakLine) peakLine.style.bottom = `${percent}%`;
      if (peakValue) peakValue.textContent = formatPeakDb(db);
      if (meter.overload) state.overloadUntil.set(track.id, now + 900);
      const overloaded = (state.overloadUntil.get(track.id) || 0) > now;
      channel.classList.toggle("overloaded", overloaded);

      if (frame % 2 === 0) {
        const waveform = engine.getWaveform(track.id, 48);
        const path = waveform
          .map((value, index) => {
            const x = (index / (waveform.length - 1)) * 120;
            const y = 39 - clamp(value * 1.65, -1, 1) * 31;
            return `${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(" L");
        const scope = $(`[data-scope="${track.id}"]`);
        if (scope) scope.setAttribute("d", `M${path}`);
      }
    }
    const reduction = engine.getCompressorReduction();
    elements.grFill.style.height = `${clamp((reduction / 18) * 100, 0, 100)}%`;
    elements.grReadout.innerHTML = `${reduction.toFixed(1)} <small>dB</small>`;
  }

  function updateRuntime(status, position) {
    elements.activeNodes.textContent = String(status.activeNodes);
    elements.nodeDetail.textContent = `${status.destroyedNodes} 个已释放 · ${status.pendingSources} 组源`;
    elements.listenerCount.textContent = String(status.listeners);
    elements.contextState.textContent = status.contextState.toUpperCase();
    elements.sampleRate.textContent = `${(status.sampleRate / 1000).toFixed(1)} kHz`;
    elements.schedulerState.textContent = status.schedulerState;
    elements.schedulerDetail.textContent = `${status.schedulerDropouts} 次漏排`;
    const beat = engine.getBeatInfo(position);
    elements.beatReadout.textContent = `BAR ${String(beat.barIndex).padStart(3, "0")} · BEAT ${beat.beatInBar}`;
    elements.sessionMapTime.textContent = formatTime(position);
    elements.timelineFill.style.width = `${(position / engine.duration) * 100}%`;
    elements.timelineHead.style.left = `${(position / engine.duration) * 100}%`;
    elements.transportTime.textContent = formatTime(position);

    const beats = elements.sessionBeats.children;
    const currentBeat = Math.floor(position / engine.beatSeconds);
    for (let index = 0; index < beats.length; index += 1) {
      beats[index].classList.toggle("passed", index <= currentBeat);
    }

    let health = "HEALTHY";
    let healthClass = "";
    let globalText = "引擎待命";
    let dotClass = "";
    let message = "按下播放以初始化音频上下文。";
    let chain = "READY";

    if (state.validationRunning) {
      health = "TESTING";
      healthClass = "warning";
      globalText = "生命周期自检中";
      dotClass = "live";
      message = "正在校验输入中断、节点销毁与重复启动。";
    } else if (status.lastError) {
      health = "ERROR";
      healthClass = "error";
      globalText = "引擎异常";
      dotClass = "error";
      message = `音频错误：${status.lastError}`;
      chain = "ERROR";
    } else if (status.inputInterrupted) {
      health = "INTERRUPTED";
      healthClass = "warning";
      globalText = "输入已中断";
      dotClass = "error";
      message = "输入门已关闭，正在检查残留尾音与未释放节点。";
      chain = "MUTED";
    } else if (engine.playing && status.routing === "preview") {
      health = "PREVIEW";
      globalText = "单轨试听中";
      dotClass = "live";
      chain = "PREVIEW · COMP BYPASSED";
      message = "独奏试听绕过总线压缩器，直接进入预览输出。";
    } else if (engine.playing) {
      globalText = "正在播放";
      dotClass = "live";
      chain = engine.settings.compressor.enabled ? "BUS COMP" : "BUS BYPASS";
      message = `调度正常 · 前瞻 340 ms · ${status.activeNodes} 个活动节点 · ${status.listeners} 个监听器`;
    } else if (status.schedulerState === "COMPLETE") {
      globalText = "播放完成";
      message = "20 秒混音已完成，音频节点已释放。";
      chain = "COMPLETE";
    } else if (status.schedulerState === "PAUSED") {
      globalText = "已暂停";
      message = "暂停时已停止全部源并断开音频图，没有残留尾音。";
      chain = "CLEAN";
    } else if (status.contextState === "running") {
      message = "音频上下文已就绪，节点计数归零，等待下一次播放。";
      chain = "READY";
    } else if (status.activeNodes > 0) {
      health = "WARNING";
      healthClass = "warning";
      globalText = "节点未释放";
      message = "检测到活动节点但播放未运行，请执行停止清理。";
      chain = "CHECK";
    }

    if (status.schedulerDropouts > 5 && !status.lastError) {
      health = "DEGRADED";
      healthClass = "warning";
    }
    elements.healthBadge.textContent = health;
    elements.healthBadge.className = `health-badge ${healthClass}`;
    elements.globalStatus.textContent = globalText;
    elements.globalStatusDot.className = `status-dot ${dotClass}`;
    elements.runtimeMessage.textContent = message;
    elements.chainState.textContent = chain;
  }

  function animationFrame(now) {
    const frame = state.frameCount;
    const status = engine.getStatus();
    const position = engine.getPosition();
    if (!state.scrubbing) {
      elements.transportTime.textContent = formatTime(position);
      elements.timeline.value = position;
    }
    updateMeters(now, frame);
    if (frame % 3 === 0 || engine.playing) updateRuntime(status, position);
    state.frameCount += 1;
    window.requestAnimationFrame(animationFrame);
  }

  function formatDbFs(value) {
    if (!Number.isFinite(Number(value))) return "— dBFS";
    return `${value > 0 ? "+" : ""}${Number(value).toFixed(2)} dBFS`;
  }

  function formatLufs(value) {
    if (!Number.isFinite(Number(value))) return "— LUFS";
    return `${Number(value).toFixed(1)} LUFS`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(Number(seconds))) return "—";
    return `${Number(seconds).toFixed(3)} s`;
  }

  function updateComparisonView(result) {
    const { bypass, compressed } = result;
    setText("bypass-peak", formatDbFs(bypass.peakDb));
    setText("bypass-loudness", formatLufs(bypass.loudness));
    setText("bypass-duration", formatDuration(bypass.duration));
    setText("compressed-peak", formatDbFs(compressed.peakDb));
    setText("compressed-loudness", formatLufs(compressed.loudness));
    setText(
      "compressed-gr",
      `${Number(compressed.gainReduction).toFixed(1)} dB`,
    );
    setText("compressed-duration", formatDuration(compressed.duration));
    setText(
      "peak-delta",
      `${result.peakDelta > 0 ? "+" : ""}${result.peakDelta.toFixed(2)} dB`,
    );
    setText(
      "loudness-delta",
      `${result.loudnessDelta > 0 ? "+" : ""}${result.loudnessDelta.toFixed(2)} LU`,
    );
    setText("analysis-state", "A/B VERIFIED");
  }

  async function runComparison(options = {}) {
    if (state.comparisonRunning || state.exportRunning) return null;
    state.comparisonRunning = true;
    const button = $("#run-comparison");
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "离线渲染中…";
    setText("analysis-state", "RENDERING");
    try {
      const result = await engine.buildComparison(clone(engine.settings));
      state.renderedComparison = result;
      updateComparisonView(result);
      setFooter("A/B RENDERED");
      if (!options.silent) {
        showToast(
          `A/B 完成：真峰值 ${formatDbFs(result.bypass.peakDb)} → ${formatDbFs(
            result.compressed.peakDb,
          )}`,
        );
      }
      return result;
    } catch (error) {
      setText("analysis-state", "ERROR");
      showToast(`A/B 渲染失败：${error.message}`, "error");
      return null;
    } finally {
      state.comparisonRunning = false;
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function exportWav() {
    if (state.exportRunning || state.comparisonRunning) return null;
    state.exportRunning = true;
    const button = $("#export-wav");
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "渲染 WAV…";
    try {
      const { blob, meta } = await engine.exportWav(clone(engine.settings));
      const mode = meta.compressorEnabled ? "bus-comp" : "bus-bypass";
      triggerDownload(blob, `mix04-20s-${mode}.wav`);
      button.textContent = "已导出";
      setText(
        "analysis-state",
        `WAV ${meta.duration.toFixed(3)} s / ${(meta.bytes / 1024 / 1024).toFixed(1)} MB`,
      );
      setFooter("WAV EXPORTED");
      showToast(
        `WAV 已导出：${meta.duration.toFixed(3)} s · 32-bit float · ${(
          meta.bytes /
          1024 /
          1024
        ).toFixed(1)} MB`,
      );
      return { blob, meta };
    } catch (error) {
      button.textContent = oldText;
      showToast(`WAV 导出失败：${error.message}`, "error");
      return null;
    } finally {
      state.exportRunning = false;
      window.setTimeout(() => {
        button.disabled = false;
        button.textContent = oldText;
      }, 1100);
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      showToast(`本地存储不可用：${error.message}`, "warning");
      return false;
    }
  }

  function readStorage(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      showToast(`读取本地工程失败：${error.message}`, "error");
      return null;
    }
  }

  function saveProject(options = {}) {
    const project = {
      format: "MIX04_PROJECT",
      version: 1,
      settings: clone(engine.settings),
      position: engine.getPosition(),
      loop: engine.loop,
      savedAt: new Date().toISOString(),
    };
    if (writeStorage(STORAGE_PROJECT, project)) {
      setFooter("PROJECT SAVED");
      if (!options.silent) {
        showToast("工程已保存：四轨参数、总线压缩与播放位置均已写入本地。");
      }
      return project;
    }
    return null;
  }

  async function loadProject(options = {}) {
    const project = readStorage(STORAGE_PROJECT);
    if (!project || !project.settings) {
      showToast("没有可载入的本地工程。", "warning");
      return null;
    }
    applySettings(project.settings, {
      position: project.position,
      loop: project.loop,
    });
    setFooter("PROJECT LOADED");
    if (!options.silent) {
      showToast("工程已载入，正在重新测量 20 秒总线输出。");
      const result = await runComparison({ silent: true });
      if (result) {
        showToast(
          `载入核验完成：${engine.settings.tracks
            .map((track) => `${track.name} ${formatPan(track.pan)} / ${track.gainDb.toFixed(1)} dB`)
            .join(" · ")}`,
        );
      }
    }
    return project;
  }

  function snapshotTimeLabel(iso) {
    if (!iso) return "NOT SAVED";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "SAVED";
    return date.toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function captureSnapshot(options = {}) {
    const snapshot = {
      format: "MIX04_SNAPSHOT",
      version: 1,
      createdAt: new Date().toISOString(),
      settings: clone(engine.settings),
      beatPoints: [...engine.beatPoints],
      position: engine.getPosition(),
      loop: engine.loop,
      duration: engine.duration,
      exportDuration:
        engine.lastExportMeta && Number.isFinite(engine.lastExportMeta.duration)
          ? engine.lastExportMeta.duration
          : engine.duration,
    };
    state.snapshot = snapshot;
    writeStorage(STORAGE_SNAPSHOT, snapshot);
    setText("snapshot-created", snapshotTimeLabel(snapshot.createdAt));
    setText("snapshot-status", "CAPTURED");
    setText("snapshot-diff", "NOT VERIFIED");
    const report = $("#snapshot-report");
    report.className = "snapshot-report";
    report.textContent =
      "快照已捕获。点击“恢复并验证”将重载全部参数并渲染实际 WAV 时长。";
    setFooter("SNAPSHOT CAPTURED");
    if (!options.silent) {
      showToast("参数快照已保存；包含节拍网格与四轨完整设置。");
    }
    return snapshot;
  }

  function compareSnapshotParameters(snapshot) {
    const source = snapshot.settings;
    const current = engine.settings;
    const beatMatch =
      snapshot.beatPoints.length === engine.beatPoints.length &&
      snapshot.beatPoints.every(
        (time, index) => Math.abs(time - engine.beatPoints[index]) < 1e-6,
      );
    let panMismatches = 0;
    let gainMismatches = 0;
    for (const track of current.tracks) {
      const original = source.tracks.find((candidate) => candidate.id === track.id);
      if (!original) {
        panMismatches += 1;
        gainMismatches += 1;
        continue;
      }
      if (Math.abs(original.pan - track.pan) > 1e-9) panMismatches += 1;
      if (Math.abs(original.gainDb - track.gainDb) > 1e-9) gainMismatches += 1;
    }
    const compressorMatch =
      JSON.stringify(source.compressor) === JSON.stringify(current.compressor);
    return {
      beatMatch,
      panMismatches,
      gainMismatches,
      compressorMatch,
    };
  }

  async function restoreSnapshot(options = {}) {
    if (state.snapshotRunning) return null;
    if (!state.snapshot) {
      showToast("尚未捕获参数快照。", "warning");
      return null;
    }
    state.snapshotRunning = true;
    const restoreButton = $("#restore-snapshot");
    const oldText = restoreButton.textContent;
    restoreButton.disabled = true;
    restoreButton.textContent = "恢复并渲染中…";
    setText("snapshot-status", "RESTORING");
    try {
      const snapshot = clone(state.snapshot);
      applySettings(snapshot.settings, {
        position: snapshot.position,
        loop: snapshot.loop,
      });
      const comparison = compareSnapshotParameters(snapshot);
      const { meta } = await engine.exportWav(clone(engine.settings));
      const expectedDuration = snapshot.exportDuration ?? snapshot.duration;
      const durationMatch =
        Math.abs(meta.duration - expectedDuration) <= 0.001;
      const parameterMismatches =
        comparison.panMismatches +
        comparison.gainMismatches +
        (comparison.beatMatch ? 0 : 1) +
        (comparison.compressorMatch ? 0 : 1) +
        (durationMatch ? 0 : 1);
      const passed = parameterMismatches === 0;
      const report = $("#snapshot-report");
      report.className = `snapshot-report ${passed ? "pass" : "fail"}`;
      report.textContent = `节拍点 ${comparison.beatMatch ? "一致" : "不一致"} · 声像 ${
        engine.settings.tracks.length - comparison.panMismatches
      }/${engine.settings.tracks.length} · 增益 ${
        engine.settings.tracks.length - comparison.gainMismatches
      }/${engine.settings.tracks.length} · WAV ${formatDuration(
        meta.duration,
      )} / ${formatDuration(expectedDuration)} · 总线 ${
        comparison.compressorMatch ? "一致" : "不一致"
      }`;
      setText("snapshot-status", passed ? "RESTORED" : "MISMATCH");
      setText(
        "snapshot-diff",
        passed ? "0 MISMATCH" : `${parameterMismatches} MISMATCH`,
      );
      $("#snapshot-diff").className = passed ? "pass" : "fail";
      setFooter("SNAPSHOT VERIFIED");
      if (!options.silent) {
        showToast(
          passed
            ? "快照恢复通过：节拍点、声像、增益与实际 WAV 时长全部一致。"
            : `快照恢复发现 ${parameterMismatches} 项不一致。`,
          passed ? "success" : "error",
        );
      }
      return {
        passed,
        comparison,
        durationMatch,
        expectedDuration,
        actualDuration: meta.duration,
      };
    } catch (error) {
      setText("snapshot-status", "ERROR");
      setText("snapshot-diff", "ERROR");
      $("#snapshot-diff").className = "fail";
      showToast(`快照恢复失败：${error.message}`, "error");
      return null;
    } finally {
      state.snapshotRunning = false;
      restoreButton.disabled = false;
      restoreButton.textContent = oldText;
    }
  }

  function markValidation(test, status, label) {
    const item = $(`.validation-item[data-test="${test}"]`);
    if (!item) return;
    item.classList.remove("is-running", "is-pass", "is-fail");
    if (status === "running") item.classList.add("is-running");
    if (status === "pass") item.classList.add("is-pass");
    if (status === "fail") item.classList.add("is-fail");
    $(".test-state", item).textContent = label;
  }

  function resetValidationUI() {
    for (const test of ["interrupt", "destruction", "repeat"]) {
      markValidation(test, "waiting", "WAITING");
    }
    setText("validation-result", "RUNNING");
    $("#validation-result").className = "mono";
    setText("tail-result", "MEASURING");
    $("#tail-result").className = "mono";
  }

  function setValidationSummary(passed) {
    setText("validation-result", passed ? "ALL PASS" : "FAILED");
    $("#validation-result").className = `mono ${passed ? "pass" : "fail"}`;
  }

  async function runValidation() {
    if (state.validationRunning || state.comparisonRunning) return null;
    state.validationRunning = true;
    const button = $("#run-validation");
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "测试中…";
    resetValidationUI();
    const results = {
      interrupt: false,
      destruction: false,
      repeat: false,
      peak: null,
    };
    try {
      await engine.ensureContext();

      markValidation("interrupt", "running", "RUNNING");
      await engine.start();
      await sleep(280);
      if (engine.graph) {
        engine.graph.masterGain.gain.setTargetAtTime(
          0.1,
          engine.ctx.currentTime,
          0.015,
        );
      }
      engine.interruptAllInputs();
      await sleep(150);
      const tailPeak = engine.getOutputPeak();
      results.peak = tailPeak;
      const noTail = tailPeak <= 0.002;
      const noSources = engine.sourceRecords.size === 0;
      const schedulerInterrupted = engine.schedulerState === "INTERRUPTED";
      results.interrupt = noTail && noSources && schedulerInterrupted;
      markValidation(
        "interrupt",
        results.interrupt ? "pass" : "fail",
        results.interrupt ? "PASS · SILENT" : "FAIL · TAIL",
      );
      setText(
        "tail-result",
        tailPeak > 0
          ? `${(20 * Math.log10(tailPeak)).toFixed(1)} dBFS`
          : "−∞ dBFS",
      );
      engine.teardownGraph();

      markValidation("destruction", "running", "RUNNING");
      await engine.start();
      await sleep(180);
      if (engine.graph) {
        engine.graph.masterGain.gain.setTargetAtTime(
          0.08,
          engine.ctx.currentTime,
          0.012,
        );
      }
      const nodesBefore = engine.activeNodes.size;
      const listenersBefore = engine.listenerRecords.length;
      engine.stop();
      await sleep(40);
      const stopped = engine.getStatus();
      results.destruction =
        nodesBefore > 0 &&
        listenersBefore >= 0 &&
        stopped.activeNodes === 0 &&
        stopped.listeners === 0 &&
        engine.graph === null;
      markValidation(
        "destruction",
        results.destruction ? "pass" : "fail",
        results.destruction ? "PASS · 0 NODES" : "FAIL · LEAK",
      );

      markValidation("repeat", "running", "1 / 3");
      const duplicateListeners = [];
      const residualNodes = [];
      let idempotentStart = true;
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        await engine.start();
        await sleep(130);
        if (engine.graph) {
          engine.graph.masterGain.gain.setTargetAtTime(
            0.06,
            engine.ctx.currentTime,
            0.012,
          );
        }
        const beforeRepeatStart = engine.activeNodes.size;
        const firstRepeat = await engine.start();
        const afterRepeatStart = engine.activeNodes.size;
        if (
          firstRepeat.started !== false ||
          afterRepeatStart !== beforeRepeatStart
        ) {
          idempotentStart = false;
        }
        const seenNodes = new Set();
        let duplicateCount = 0;
        for (const record of engine.listenerRecords) {
          if (seenNodes.has(record.node)) duplicateCount += 1;
          seenNodes.add(record.node);
        }
        duplicateListeners.push(duplicateCount);
        engine.stop();
        await sleep(30);
        residualNodes.push(engine.activeNodes.size);
        markValidation("repeat", "running", `${cycle + 1} / 3`);
      }
      results.repeat =
        idempotentStart &&
        residualNodes.every((count) => count === 0) &&
        duplicateListeners.every((count) => count <= 0) &&
        engine.listenerRecords.length === 0;
      markValidation(
        "repeat",
        results.repeat ? "pass" : "fail",
        results.repeat ? "PASS · STABLE" : "FAIL · DUPLICATE",
      );

      const passed = results.interrupt && results.destruction && results.repeat;
      setValidationSummary(passed);
      setFooter("LIFECYCLE VERIFIED");
      showToast(
        passed
          ? "生命周期自检通过：零尾音、零残留节点、三次启停监听器稳定。"
          : "生命周期自检未通过，请查看运行状态与调度计数。",
        passed ? "success" : "error",
      );
      return results;
    } catch (error) {
      showToast(`自检失败：${error.message}`, "error");
      setValidationSummary(false);
      return { ...results, error: error.message };
    } finally {
      engine.stop();
      state.validationRunning = false;
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  async function simulateInputInterruption() {
    if (state.validationRunning || state.comparisonRunning) return null;
    state.validationRunning = true;
    const button = $("#simulate-interrupt");
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = "中断中…";
    markValidation("interrupt", "running", "RUNNING");
    try {
      if (!engine.playing) {
        await engine.start();
        await sleep(260);
      }
      if (engine.graph) {
        engine.graph.masterGain.gain.setTargetAtTime(
          0.08,
          engine.ctx.currentTime,
          0.012,
        );
      }
      engine.interruptAllInputs();
      await sleep(150);
      const peak = engine.getOutputPeak();
      const passed = peak <= 0.002 && engine.sourceRecords.size === 0;
      markValidation(
        "interrupt",
        passed ? "pass" : "fail",
        passed ? "PASS · SILENT" : "FAIL · TAIL",
      );
      setText(
        "tail-result",
        peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : "−∞ dBFS",
      );
      setText("validation-result", passed ? "INTERRUPT PASS" : "INTERRUPT FAIL");
      $("#validation-result").className = `mono ${passed ? "pass" : "fail"}`;
      showToast(
        passed
          ? "输入中断验证通过：150 ms 后输出已静音，源节点已停止。"
          : "输入中断后仍有残留信号。",
        passed ? "success" : "error",
      );
      return { passed, peak };
    } catch (error) {
      markValidation("interrupt", "fail", "FAIL · ERROR");
      showToast(`中断验证失败：${error.message}`, "error");
      return { passed: false, error: error.message };
    } finally {
      engine.stop();
      state.validationRunning = false;
      button.disabled = false;
      button.textContent = oldText;
    }
  }

  function bindEvents() {
    elements.channels.addEventListener("input", handleTrackInput);
    elements.channels.addEventListener("click", handleTrackClick);
    elements.channels.addEventListener("dblclick", resetTrackVolume);
    elements.compressorControls.addEventListener(
      "input",
      handleCompressorInput,
    );
    elements.bypassButton.addEventListener("click", () => {
      engine.settings.compressor.enabled =
        !engine.settings.compressor.enabled;
      engine.updateLiveCompressor();
      updateCompressorUI();
      setFooter(
        engine.settings.compressor.enabled ? "COMPRESSOR ACTIVE" : "BUS BYPASS",
      );
    });
    $("#save-project").addEventListener("click", () => saveProject());
    $("#load-project").addEventListener("click", () => loadProject());
    $("#export-wav").addEventListener("click", () => exportWav());
    $("#run-comparison").addEventListener("click", () => runComparison());
    $("#run-validation").addEventListener("click", () => runValidation());
    $("#simulate-interrupt").addEventListener("click", () =>
      simulateInputInterruption(),
    );
    $("#capture-snapshot").addEventListener("click", () => captureSnapshot());
    $("#restore-snapshot").addEventListener("click", () => restoreSnapshot());
    $("#reset-mix").addEventListener("click", () => {
      engine.stop();
      engine.settings.tracks = defaultTracks();
      syncAllControls();
      engine.notify("reset");
      setFooter("CHANNELS RESET");
      showToast("四轨通道参数已恢复默认值。");
    });
    $("#transport-play").addEventListener("click", toggleTransport);
    $("#transport-stop").addEventListener("click", () => {
      engine.stop();
      syncTransport();
      setFooter("ENGINE STOPPED");
    });
    $("#transport-reset").addEventListener("click", async () => {
      await engine.seek(0);
      syncTransport();
    });
    $("#loop-toggle").addEventListener("click", () => {
      engine.setLoop(!engine.loop);
      syncTransport();
    });
    elements.timeline.addEventListener("input", () => {
      state.scrubbing = true;
      const position = Number(elements.timeline.value);
      elements.transportTime.textContent = formatTime(position);
      elements.timelineFill.style.width = `${(position / engine.duration) * 100}%`;
      elements.timelineHead.style.left = `${(position / engine.duration) * 100}%`;
    });
    elements.timeline.addEventListener("change", async () => {
      const position = Number(elements.timeline.value);
      state.scrubbing = false;
      await engine.seek(position);
      syncTransport();
    });
    window.addEventListener("keydown", (event) => {
      if (event.code !== "Space") return;
      const tag = event.target && event.target.tagName;
      if (["INPUT", "BUTTON", "TEXTAREA", "SELECT"].includes(tag)) return;
      event.preventDefault();
      toggleTransport();
    });
  }

  function loadPersistedSnapshot() {
    const snapshot = readStorage(STORAGE_SNAPSHOT);
    if (!snapshot || !snapshot.settings || !Array.isArray(snapshot.beatPoints)) {
      return;
    }
    state.snapshot = snapshot;
    setText("snapshot-created", snapshotTimeLabel(snapshot.createdAt));
    setText("snapshot-status", "SAVED");
    setText("snapshot-diff", "NOT VERIFIED");
  }

  async function initialize() {
    buildChannels();
    buildCompressorControls();
    buildSessionVisual();
    loadPersistedSnapshot();
    syncAllControls();
    bindEvents();
    window.requestAnimationFrame(animationFrame);

    window.mixApp = {
      engine,
      state,
      start: () => engine.start(),
      pause: () => engine.pause(),
      stop: () => engine.stop(),
      seek: (seconds) => engine.seek(seconds),
      play: () => engine.start(),
      getMetrics: () => engine.getStatus(),
      getSettings: () => clone(engine.settings),
      getBeatPoints: () => [...engine.beatPoints],
      getAnalysis: () => clone(state.renderedComparison),
      getLastExport: () => (engine.lastExportMeta ? { ...engine.lastExportMeta } : null),
      getSnapshot: () => (state.snapshot ? clone(state.snapshot) : null),
      saveProject,
      loadProject,
      captureSnapshot,
      restoreSnapshot,
      runComparison,
      runValidation,
      simulateInputInterruption,
      exportWav,
      applySettings,
      duration: engine.duration,
      beatSeconds: engine.beatSeconds,
    };

    window.setTimeout(async () => {
      const result = await runComparison({ silent: true });
      if (result && !engine.playing) {
        captureSnapshot({ silent: true });
        await restoreSnapshot({ silent: true });
      }
    }, 450);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
