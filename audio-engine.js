(function () {
  "use strict";

  const DURATION = 20;
  const BPM = 104;
  const SAMPLE_RATE = 48000;
  const BEAT_SECONDS = 60 / BPM;
  const OVERLOAD_LINEAR = 0.955;

  const TRACK_DEFINITIONS = [
    {
      id: "drums",
      index: "01",
      name: "鼓",
      en: "DRUMS / KIT 01",
      color: "#cdfc58",
      gainDb: -3.5,
      pan: -0.08,
      eq: { low: 1.5, mid: -0.5, high: 1 },
    },
    {
      id: "bass",
      index: "02",
      name: "贝斯",
      en: "BASS / SUB 02",
      color: "#78b8f5",
      gainDb: -5.5,
      pan: 0.03,
      eq: { low: 2, mid: -1.5, high: -1 },
    },
    {
      id: "ambience",
      index: "03",
      name: "环境",
      en: "AMBIENCE / AIR 03",
      color: "#b9a5ff",
      gainDb: -8,
      pan: -0.24,
      eq: { low: -1.5, mid: 0.5, high: 2.5 },
    },
    {
      id: "broadcast",
      index: "04",
      name: "广播",
      en: "BROADCAST / AUX 04",
      color: "#ffb464",
      gainDb: -9,
      pan: 0.26,
      eq: { low: -3, mid: 2.5, high: -1.5 },
    },
  ];

  const DEFAULT_COMPRESSOR = {
    enabled: true,
    threshold: -24,
    ratio: 4,
    attack: 0.005,
    release: 0.18,
    makeup: 1.5,
    knee: 6,
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const dbToGain = (db) => Math.pow(10, db / 20);
  const gainToDb = (gain) => 20 * Math.log10(Math.max(gain, 1e-9));
  const round = (value, places = 2) => Number(value.toFixed(places));

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function defaultTracks() {
    return TRACK_DEFINITIONS.map((track) => ({
      ...clone(track),
      mute: false,
      solo: false,
    }));
  }

  function defaultSettings() {
    return {
      version: 1,
      tracks: defaultTracks(),
      compressor: { ...DEFAULT_COMPRESSOR },
    };
  }

  function createNoiseBuffer(context, seconds = 2) {
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2f6e2b1;
    for (let index = 0; index < length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[index] = (seed / 4294967296) * 2 - 1;
    }
    return buffer;
  }

  function softClip(value) {
    return Math.tanh(value * 1.25) / Math.tanh(1.25);
  }

  function formatPan(pan) {
    const amount = Math.round(Math.abs(pan) * 100);
    if (amount === 0) return "C";
    return `${pan < 0 ? "L" : "R"} ${String(amount).padStart(2, "0")}`;
  }

  function staticGainReductionDb(inputDb, compressor) {
    const overshoot = inputDb - compressor.threshold;
    const knee = compressor.knee;
    const ratioFactor = 1 / compressor.ratio - 1;
    if (overshoot <= -knee / 2) return 0;
    if (overshoot < knee / 2) {
      return Math.min(0, (ratioFactor * Math.pow(overshoot + knee / 2, 2)) / (2 * knee));
    }
    return ratioFactor * overshoot;
  }

  class MixEngine {
    constructor(options = {}) {
      this.duration = DURATION;
      this.bpm = BPM;
      this.beatSeconds = BEAT_SECONDS;
      this.sampleRate = SAMPLE_RATE;
      this.settings = options.settings || defaultSettings();
      this.onChange = options.onChange || function () {};
      this.ctx = null;
      this.graph = null;
      this.playing = false;
      this.position = 0;
      this.startPosition = 0;
      this.startedAt = 0;
      this.loop = true;
      this.inputInterrupted = false;
      this.schedulerState = "IDLE";
      this.schedulerTimer = null;
      this.schedulerDropouts = 0;
      this.startCount = 0;
      this.eventCursor = 0;
      this.scheduledThrough = 0;
      this.events = this.buildArrangement();
      this.beatPoints = this.buildBeatPoints();
      this.activeNodes = new Set();
      this.sourceRecords = new Set();
      this.listenerRecords = [];
      this.meterBuffers = new Map();
      this.destroyedNodes = 0;
      this.lastExportMeta = null;
      this.lastAnalysis = null;
      this.noiseBuffer = null;
      this.noiseBuffers = new WeakMap();
      this.lastError = null;
    }

    getTrack(trackId) {
      return this.settings.tracks.find((track) => track.id === trackId);
    }

    buildBeatPoints() {
      const count = Math.floor(this.duration / this.beatSeconds) + 1;
      return Array.from({ length: count }, (_, index) =>
        round(index * this.beatSeconds, 6),
      );
    }

    buildArrangement() {
      const events = [];
      const totalEighths = Math.floor(this.duration / (this.beatSeconds / 2));
      const chords = [
        [48, 51, 55, 58],
        [44, 48, 51, 55],
        [51, 55, 58, 62],
        [46, 50, 53, 58],
      ];
      const bassNotes = [36, 36, 44, 39, 43, 43, 39, 34];
      const bassPattern = [0, 0, 12, 0, 7, 0, 10, 12];
      const broadcastPhrases = [0.48, 0.72, 0.36, 0.62, 0.84, 0.55, 0.68, 0.74];

      for (let step = 0; step < totalEighths; step += 1) {
        const time = round((step * this.beatSeconds) / 2, 6);
        const beat = step / 2;
        const beatInBar = Math.floor(beat) % 4;
        const bar = Math.floor(beat / 4);
        const stepInBar = step % 8;

        if (
          (beatInBar === 0 || beatInBar === 2) &&
          stepInBar % 2 === 0
        ) {
          events.push({
            trackId: "drums",
            type: "kick",
            time,
            velocity: stepInBar === 0 ? 1.38 : 1.22,
          });
        }
        if ((beatInBar === 1 || beatInBar === 3) && stepInBar % 2 === 0) {
          events.push({
            trackId: "drums",
            type: "snare",
            time,
            velocity: beatInBar === 3 ? 0.92 : 0.78,
          });
        }
        if (stepInBar === 7 && bar % 2 === 1) {
          events.push({
            trackId: "drums",
            type: "snare",
            time: round(time + this.beatSeconds * 0.16, 6),
            velocity: 0.38,
          });
        }
        events.push({
          trackId: "drums",
          type: "hat",
          time,
          velocity: step % 2 === 0 ? 0.3 : 0.19,
        });

        if (step % 2 === 0 || (stepInBar === 3 && bar % 2 === 1)) {
          const patternIndex = step % bassPattern.length;
          events.push({
            trackId: "bass",
            type: "bass",
            time,
            midi: bassNotes[bar % bassNotes.length] + bassPattern[patternIndex],
            length: this.beatSeconds * 0.37,
            velocity: step % 2 === 0 ? 0.54 : 0.36,
          });
        }

        if (stepInBar === 0) {
          events.push({
            trackId: "ambience",
            type: "pad",
            time,
            midi: chords[bar % chords.length],
            length: this.beatSeconds * (bar % 3 === 2 ? 4.4 : 3.5),
            velocity: bar % 2 === 0 ? 0.18 : 0.14,
          });
        }

        if (stepInBar === 0 && (bar === 1 || bar === 4 || bar === 7)) {
          events.push({
            trackId: "broadcast",
            type: "broadcast",
            time: round(time + this.beatSeconds * 0.02, 6),
            length: this.beatSeconds * 3.2,
            phrase: broadcastPhrases[bar % broadcastPhrases.length],
          });
        }
      }

      return events.sort((left, right) => left.time - right.time);
    }

    notify(type = "change") {
      this.onChange(type);
    }

    async ensureContext() {
      if (!this.ctx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          throw new Error("当前浏览器不支持 Web Audio API");
        }
        try {
          this.ctx = new AudioContextClass({
            latencyHint: "interactive",
            sampleRate: SAMPLE_RATE,
          });
        } catch (error) {
          this.ctx = new AudioContextClass({ latencyHint: "interactive" });
        }
        this.sampleRate = this.ctx.sampleRate;
      }
      if (this.ctx.state === "suspended") {
        await this.ctx.resume();
      }
      return this.ctx;
    }

    registerNode(node, trackId = "bus", registerSet = this.activeNodes) {
      if (!registerSet) return node;
      registerSet.add(node);
      node.__mixTrackId = trackId;
      return node;
    }

    attachListener(node, eventName, handler, label = "audio-node") {
      node.addEventListener(eventName, handler);
      this.listenerRecords.push({ node, eventName, handler, label });
    }

    detachListener(record) {
      try {
        record.node.removeEventListener(record.eventName, record.handler);
      } catch (error) {
        this.lastError = error;
      }
      const index = this.listenerRecords.indexOf(record);
      if (index >= 0) this.listenerRecords.splice(index, 1);
    }

    removeAllListeners() {
      [...this.listenerRecords].forEach((record) => this.detachListener(record));
      this.listenerRecords.length = 0;
    }

    buildGraph(context, settings, registerSet) {
      const add = (node, trackId) => this.registerNode(node, trackId, registerSet);
      const busInput = add(context.createGain(), "bus");
      const compressor = add(context.createDynamicsCompressor(), "compressor");
      const makeup = add(context.createGain(), "bus");
      const masterGain = add(context.createGain(), "master");
      const masterAnalyser = registerSet
        ? add(context.createAnalyser(), "master")
        : null;
      const previewGain = registerSet ? add(context.createGain(), "preview") : null;
      const compressorSettings = settings.compressor;

      busInput.gain.value = 1;
      compressor.threshold.value = compressorSettings.threshold;
      compressor.knee.value = compressorSettings.knee;
      compressor.ratio.value = compressorSettings.ratio;
      compressor.attack.value = compressorSettings.attack;
      compressor.release.value = compressorSettings.release;
      makeup.gain.value = compressorSettings.enabled
        ? dbToGain(compressorSettings.makeup)
        : 1;
      masterGain.gain.value = 0.92;

      if (compressorSettings.enabled) {
        busInput.connect(compressor);
        compressor.connect(makeup);
      } else {
        busInput.connect(makeup);
      }

      makeup.connect(masterGain);
      if (masterAnalyser) {
        masterAnalyser.fftSize = 1024;
        masterAnalyser.smoothingTimeConstant = 0.62;
        masterGain.connect(masterAnalyser);
        masterAnalyser.connect(context.destination);
      } else {
        masterGain.connect(context.destination);
      }

      if (previewGain) {
        previewGain.gain.value = 0.92;
        previewGain.connect(context.destination);
      }

      const tracks = {};
      for (const track of settings.tracks) {
        const input = add(context.createGain(), track.id);
        const low = add(context.createBiquadFilter(), track.id);
        const mid = add(context.createBiquadFilter(), track.id);
        const high = add(context.createBiquadFilter(), track.id);
        const fader = add(context.createGain(), track.id);
        const panner = add(context.createStereoPanner(), track.id);
        const analyser = registerSet ? add(context.createAnalyser(), track.id) : null;

        low.type = "lowshelf";
        low.frequency.value = 120;
        low.gain.value = track.eq.low;
        mid.type = "peaking";
        mid.frequency.value = 1150;
        mid.Q.value = 0.82;
        mid.gain.value = track.eq.mid;
        high.type = "highshelf";
        high.frequency.value = 7200;
        high.gain.value = track.eq.high;
        fader.gain.value = track.mute ? 0 : dbToGain(track.gainDb);
        panner.pan.value = track.pan;

        input.connect(low);
        low.connect(mid);
        mid.connect(high);
        high.connect(fader);
        fader.connect(panner);
        if (analyser) {
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.28;
          panner.connect(analyser);
          analyser.connect(busInput);
        } else {
          panner.connect(busInput);
        }

        tracks[track.id] = {
          input,
          low,
          mid,
          high,
          fader,
          panner,
          analyser,
          output: analyser || panner,
        };
      }

      return {
        context,
        busInput,
        compressor,
        makeup,
        masterGain,
        masterAnalyser,
        previewGain,
        tracks,
        routing: "bus",
      };
    }

    updateLiveRouting() {
      if (!this.graph) return;
      const graph = this.graph;
      const soloTracks = this.settings.tracks.filter(
        (track) => track.solo && !track.mute,
      );
      const previewing = soloTracks.length > 0 && Boolean(graph.previewGain);

      for (const track of this.settings.tracks) {
        const trackGraph = graph.tracks[track.id];
        try {
          trackGraph.output.disconnect();
        } catch (error) {
          this.lastError = error;
        }
        if (!previewing) {
          trackGraph.output.connect(graph.busInput);
        } else if (track.solo && !track.mute) {
          trackGraph.output.connect(graph.previewGain);
        }
      }
      graph.routing = previewing ? "preview" : "bus";
      this.notify("routing");
    }

    updateLiveCompressor() {
      if (!this.graph) return;
      const graph = this.graph;
      const compressor = this.settings.compressor;
      graph.compressor.threshold.setTargetAtTime(
        compressor.threshold,
        this.ctx.currentTime,
        0.02,
      );
      graph.compressor.knee.setTargetAtTime(
        compressor.knee,
        this.ctx.currentTime,
        0.02,
      );
      graph.compressor.ratio.setTargetAtTime(
        compressor.ratio,
        this.ctx.currentTime,
        0.02,
      );
      graph.compressor.attack.setTargetAtTime(
        compressor.attack,
        this.ctx.currentTime,
        0.02,
      );
      graph.compressor.release.setTargetAtTime(
        compressor.release,
        this.ctx.currentTime,
        0.02,
      );
      graph.makeup.gain.setTargetAtTime(
        compressor.enabled ? dbToGain(compressor.makeup) : 1,
        this.ctx.currentTime,
        0.02,
      );
      try {
        graph.busInput.disconnect();
        graph.compressor.disconnect();
      } catch (error) {
        this.lastError = error;
      }
      if (compressor.enabled) {
        graph.busInput.connect(graph.compressor);
        graph.compressor.connect(graph.makeup);
      } else {
        graph.busInput.connect(graph.makeup);
      }
      this.notify("compressor");
    }

    applyTrackSettings(trackId) {
      if (!this.graph) return;
      const track = this.getTrack(trackId);
      const trackGraph = this.graph.tracks[trackId];
      if (!track || !trackGraph) return;
      const now = this.ctx.currentTime;
      trackGraph.fader.gain.setTargetAtTime(
        track.mute ? 0 : dbToGain(track.gainDb),
        now,
        0.012,
      );
      trackGraph.panner.pan.setTargetAtTime(track.pan, now, 0.012);
      trackGraph.low.gain.setTargetAtTime(track.eq.low, now, 0.02);
      trackGraph.mid.gain.setTargetAtTime(track.eq.mid, now, 0.02);
      trackGraph.high.gain.setTargetAtTime(track.eq.high, now, 0.02);
      this.notify("track");
    }

    async start() {
      if (this.playing) {
        return { started: false, reason: "already-playing" };
      }
      try {
        this.lastError = null;
        this.inputInterrupted = false;
        await this.ensureContext();
        if (this.position >= this.duration - 0.02) this.position = 0;
        this.teardownGraph({ notify: false });
        this.graph = this.buildGraph(
          this.ctx,
          this.settings,
          this.activeNodes,
        );
        this.updateLiveRouting();
        this.playing = true;
        this.startPosition = this.position;
        this.startedAt = this.ctx.currentTime + 0.045;
        this.scheduledThrough = this.position;
        this.eventCursor = this.events.findIndex(
          (event) => event.time >= this.position - 0.001,
        );
        if (this.eventCursor < 0) this.eventCursor = this.events.length;
        this.schedulerState = "SCHEDULING";
        this.schedulerDropouts = 0;
        this.startCount += 1;
        this.tickScheduler();
        this.schedulerTimer = window.setInterval(
          () => this.tickScheduler(),
          40,
        );
        this.notify("start");
        return { started: true, contextState: this.ctx.state };
      } catch (error) {
        this.lastError = error;
        this.playing = false;
        this.schedulerState = "ERROR";
        this.teardownGraph({ notify: false });
        this.notify("error");
        throw error;
      }
    }

    tickScheduler() {
      if (!this.playing || !this.graph || !this.ctx) return;
      if (this.schedulerState === "INTERRUPTED") return;
      const now = this.ctx.currentTime;
      let position = this.getPosition();

      if (position >= this.duration - 0.002) {
        if (this.loop) {
          this.startPosition = 0;
          this.startedAt = now + 0.025;
          this.position = 0;
          this.scheduledThrough = 0;
          this.eventCursor = 0;
          position = 0;
        } else {
          this.finishPlayback();
          return;
        }
      }

      const horizon = position + 0.34;
      while (
        this.eventCursor < this.events.length &&
        this.events[this.eventCursor].time <= horizon
      ) {
        const event = this.events[this.eventCursor];
        const delay = this.startedAt + (event.time - this.startPosition) - now;
        const when = now + Math.max(0.006, delay);
        if (delay < -0.012) this.schedulerDropouts += 1;
        try {
          this.scheduleEvent(
            this.ctx,
            this.graph,
            event,
            when,
            this.activeNodes,
            true,
          );
        } catch (error) {
          this.lastError = error;
          this.schedulerDropouts += 1;
        }
        this.scheduledThrough = event.time;
        this.eventCursor += 1;
      }
      this.notify("tick");
    }

    finishPlayback() {
      this.clearSchedulerTimer();
      this.position = this.duration;
      this.playing = false;
      this.schedulerState = "COMPLETE";
      this.teardownGraph({ notify: false });
      this.notify("complete");
    }

    clearSchedulerTimer() {
      if (this.schedulerTimer !== null) {
        window.clearInterval(this.schedulerTimer);
        this.schedulerTimer = null;
      }
    }

    getPosition() {
      if (!this.playing || !this.ctx) return this.position;
      return clamp(
        this.startPosition + Math.max(0, this.ctx.currentTime - this.startedAt),
        0,
        this.duration,
      );
    }

    pause(options = {}) {
      const wasPlaying = this.playing;
      if (wasPlaying) this.position = this.getPosition();
      this.playing = false;
      this.clearSchedulerTimer();
      this.schedulerState = wasPlaying ? "PAUSED" : this.schedulerState;
      this.teardownGraph({ notify: false });
      if (options.notify !== false) this.notify("pause");
      return this.position;
    }

    stop() {
      this.clearSchedulerTimer();
      this.playing = false;
      this.position = 0;
      this.schedulerState = "IDLE";
      this.inputInterrupted = false;
      this.teardownGraph({ notify: false });
      this.notify("stop");
      return true;
    }

    async seek(seconds) {
      const wasPlaying = this.playing;
      const target = clamp(Number(seconds) || 0, 0, this.duration);
      if (wasPlaying) {
        this.clearSchedulerTimer();
        this.playing = false;
        this.teardownGraph({ notify: false });
      }
      this.position = target;
      if (wasPlaying) {
        await this.start();
      } else {
        this.notify("seek");
      }
      return target;
    }

    setLoop(enabled) {
      this.loop = Boolean(enabled);
      this.notify("loop");
      return this.loop;
    }

    interruptAllInputs() {
      if (!this.graph) {
        this.inputInterrupted = true;
        this.schedulerState = "INTERRUPTED";
        this.notify("interrupt");
        return { interrupted: false, reason: "no-graph" };
      }
      const now = this.ctx.currentTime;
      this.position = this.getPosition();
      this.playing = false;
      this.inputInterrupted = true;
      this.clearSchedulerTimer();
      this.schedulerState = "INTERRUPTED";
      const master = this.graph.masterGain.gain;
      master.cancelScheduledValues(now);
      master.setValueAtTime(master.value, now);
      master.linearRampToValueAtTime(0, now + 0.012);
      master.setValueAtTime(0, now + 0.014);
      [...this.sourceRecords].forEach((record) =>
        this.cleanupSourceRecord(record, true),
      );
      this.notify("interrupt");
      return { interrupted: true, position: this.position, at: now };
    }

    teardownGraph(options = {}) {
      this.clearSchedulerTimer();
      const nodeCount = this.activeNodes.size;
      for (const record of [...this.sourceRecords]) {
        this.cleanupSourceRecord(record, true);
      }
      for (const node of this.activeNodes) {
        try {
          node.disconnect();
        } catch (error) {
          this.lastError = error;
        }
      }
      this.removeAllListeners();
      this.activeNodes.clear();
      this.sourceRecords.clear();
      this.meterBuffers.clear();
      this.graph = null;
      this.destroyedNodes += nodeCount;
      if (options.notify === true) this.notify("teardown");
      return nodeCount;
    }

    getBeatInfo(position = this.getPosition()) {
      const beatFloat = position / this.beatSeconds;
      const beatIndex = Math.floor(beatFloat) + 1;
      const barIndex = Math.floor((beatIndex - 1) / 4) + 1;
      const beatInBar = ((beatIndex - 1) % 4) + 1;
      return {
        beatIndex,
        barIndex,
        beatInBar,
        beatFloat: round(beatFloat, 3),
        nextBeat: round(
          Math.ceil(position / this.beatSeconds + 0.00001) * this.beatSeconds,
          3,
        ),
      };
    }

    getNoiseBuffer(context) {
      let buffer = this.noiseBuffers.get(context);
      if (!buffer) {
        buffer = createNoiseBuffer(context, 2.5);
        this.noiseBuffers.set(context, buffer);
      }
      return buffer;
    }

    createEventGroup(context, graph, trackId, registerSet, live) {
      const record = {
        nodes: new Set(),
        sources: [],
        trackId,
        listener: null,
        cleaned: false,
        live: Boolean(live),
      };
      const own = (node) => {
        record.nodes.add(node);
        if (registerSet) {
          registerSet.add(node);
          node.__mixTrackId = trackId;
        }
        return node;
      };
      const attachSource = (source, when, stopAt, offset = 0) => {
        record.sources.push(source);
        if (offset > 0) {
          source.start(when, offset);
        } else {
          source.start(when);
        }
        source.stop(Math.max(when + 0.002, stopAt));
        return source;
      };
      const finalize = () => {
        if (!live) return record;
        if (record.sources.length === 0) {
          this.cleanupSourceRecord(record, false);
          return record;
        }
        this.sourceRecords.add(record);
        const primary = record.sources[0];
        const onEnded = () => {
          this.cleanupSourceRecord(record, false);
        };
        record.listener = { node: primary, eventName: "ended", handler: onEnded };
        this.attachListener(primary, "ended", onEnded, "event-source");
        record.listener = this.listenerRecords[this.listenerRecords.length - 1];
        return record;
      };
      return { record, own, attachSource, finalize };
    }

    cleanupSourceRecord(record, stopSources) {
      if (!record || record.cleaned) return;
      record.cleaned = true;
      if (stopSources) {
        for (const source of record.sources) {
          try {
            source.stop();
          } catch (error) {
            this.lastError = error;
          }
        }
      }
      if (record.listener) {
        this.detachListener(record.listener);
      }
      for (const node of record.nodes) {
        this.activeNodes.delete(node);
        try {
          node.disconnect();
        } catch (error) {
          this.lastError = error;
        }
      }
      record.nodes.clear();
      this.sourceRecords.delete(record);
    }

    scheduleEvent(context, graph, event, when, registerSet, live) {
      const trackGraph = graph.tracks[event.trackId];
      if (!trackGraph) return null;
      if (event.type === "kick") return this.scheduleKick(context, trackGraph, event, when, registerSet, live);
      if (event.type === "snare") return this.scheduleSnare(context, trackGraph, event, when, registerSet, live);
      if (event.type === "hat") return this.scheduleHat(context, trackGraph, event, when, registerSet, live);
      if (event.type === "bass") return this.scheduleBass(context, trackGraph, event, when, registerSet, live);
      if (event.type === "pad") return this.schedulePad(context, trackGraph, event, when, registerSet, live);
      if (event.type === "broadcast") return this.scheduleBroadcast(context, trackGraph, event, when, registerSet, live);
      return null;
    }

    scheduleKick(context, trackGraph, event, when, registerSet, live) {
      const group = this.createEventGroup(context, null, "drums", registerSet, live);
      const body = group.own(context.createGain());
      const osc = group.own(context.createOscillator());
      body.gain.setValueAtTime(0.0001, when);
      body.gain.exponentialRampToValueAtTime(event.velocity * 0.84, when + 0.006);
      body.gain.exponentialRampToValueAtTime(0.0001, when + 0.43);
      osc.type = "sine";
      osc.frequency.setValueAtTime(158, when);
      osc.frequency.exponentialRampToValueAtTime(43, when + 0.17);
      osc.connect(body);
      body.connect(trackGraph.input);
      group.attachSource(osc, when, when + 0.45);

      const clickGain = group.own(context.createGain());
      const clickFilter = group.own(context.createBiquadFilter());
      const click = group.own(context.createBufferSource());
      click.buffer = this.getNoiseBuffer(context);
      clickFilter.type = "highpass";
      clickFilter.frequency.value = 2600;
      clickGain.gain.setValueAtTime(event.velocity * 0.2, when);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.026);
      click.connect(clickFilter);
      clickFilter.connect(clickGain);
      clickGain.connect(trackGraph.input);
      group.attachSource(click, when, when + 0.03, (event.time * 1.73) % 2.2);
      return group.finalize();
    }

    scheduleSnare(context, trackGraph, event, when, registerSet, live) {
      const group = this.createEventGroup(context, null, "drums", registerSet, live);
      const noise = group.own(context.createBufferSource());
      const filter = group.own(context.createBiquadFilter());
      const noiseGain = group.own(context.createGain());
      noise.buffer = this.getNoiseBuffer(context);
      filter.type = "highpass";
      filter.frequency.value = 1050;
      filter.Q.value = 0.6;
      noiseGain.gain.setValueAtTime(event.velocity * 0.32, when);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);
      noise.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(trackGraph.input);
      group.attachSource(noise, when, when + 0.26, (event.time * 2.9) % 2.4);

      const tone = group.own(context.createOscillator());
      const toneGain = group.own(context.createGain());
      tone.type = "triangle";
      tone.frequency.setValueAtTime(185, when);
      tone.frequency.exponentialRampToValueAtTime(128, when + 0.08);
      toneGain.gain.setValueAtTime(event.velocity * 0.18, when);
      toneGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
      tone.connect(toneGain);
      toneGain.connect(trackGraph.input);
      group.attachSource(tone, when, when + 0.14);
      return group.finalize();
    }

    scheduleHat(context, trackGraph, event, when, registerSet, live) {
      const group = this.createEventGroup(context, null, "drums", registerSet, live);
      const noise = group.own(context.createBufferSource());
      const filter = group.own(context.createBiquadFilter());
      const gain = group.own(context.createGain());
      noise.buffer = this.getNoiseBuffer(context);
      filter.type = "highpass";
      filter.frequency.value = 7600;
      gain.gain.setValueAtTime(event.velocity * 0.17, when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
      noise.connect(filter);
      filter.connect(gain);
      gain.connect(trackGraph.input);
      group.attachSource(noise, when, when + 0.07, (event.time * 3.7) % 2.3);
      return group.finalize();
    }

    midiToFrequency(midi) {
      return 440 * Math.pow(2, (midi - 69) / 12);
    }

    scheduleBass(context, trackGraph, event, when, registerSet, live) {
      const group = this.createEventGroup(context, null, "bass", registerSet, live);
      const filter = group.own(context.createBiquadFilter());
      const envelope = group.own(context.createGain());
      const saw = group.own(context.createOscillator());
      const sub = group.own(context.createOscillator());
      const frequency = this.midiToFrequency(event.midi);
      const length = Math.max(0.08, event.length);

      filter.type = "lowpass";
      filter.frequency.setValueAtTime(630, when);
      filter.frequency.exponentialRampToValueAtTime(240, when + length);
      filter.Q.value = 2.2;
      envelope.gain.setValueAtTime(0.0001, when);
      envelope.gain.exponentialRampToValueAtTime(
        Math.max(0.0002, event.velocity * 0.62),
        when + 0.018,
      );
      envelope.gain.setValueAtTime(event.velocity * 0.48, when + length * 0.55);
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + length + 0.12);

      saw.type = "sawtooth";
      saw.frequency.value = frequency;
      sub.type = "sine";
      sub.frequency.value = frequency / 2;
      saw.connect(filter);
      sub.connect(filter);
      filter.connect(envelope);
      envelope.connect(trackGraph.input);
      group.attachSource(saw, when, when + length + 0.14);
      group.attachSource(sub, when, when + length + 0.14);
      return group.finalize();
    }

    schedulePad(context, trackGraph, event, when, registerSet, live) {
      const group = this.createEventGroup(context, null, "ambience", registerSet, live);
      const filter = group.own(context.createBiquadFilter());
      const envelope = group.own(context.createGain());
      const attack = Math.min(0.85, event.length * 0.3);
      const release = Math.min(1.25, event.length * 0.42);
      const stopAt = when + event.length + release;

      filter.type = "lowpass";
      filter.frequency.value = 1850;
      filter.Q.value = 0.38;
      envelope.gain.setValueAtTime(0.0001, when);
      envelope.gain.linearRampToValueAtTime(
        event.velocity,
        when + attack,
      );
      envelope.gain.setValueAtTime(
        event.velocity,
        when + Math.max(attack + 0.02, event.length - release * 0.35),
      );
      envelope.gain.exponentialRampToValueAtTime(0.0001, stopAt);
      filter.connect(envelope);
      envelope.connect(trackGraph.input);

      event.midi.forEach((midi, index) => {
        const oscillator = group.own(context.createOscillator());
        oscillator.type = index === 0 ? "sine" : "triangle";
        oscillator.frequency.value = this.midiToFrequency(midi + (index === 2 ? 12 : 0));
        oscillator.detune.value = [-7, 4, 9][index] || 0;
        oscillator.connect(filter);
        group.attachSource(oscillator, when, stopAt);
      });
      return group.finalize();
    }

    scheduleBroadcast(context, trackGraph, event, when, registerSet, live) {
      const group = this.createEventGroup(
        context,
        null,
        "broadcast",
        registerSet,
        live,
      );
      const noise = group.own(context.createBufferSource());
      const band = group.own(context.createBiquadFilter());
      const highpass = group.own(context.createBiquadFilter());
      const envelope = group.own(context.createGain());
      const carrier = group.own(context.createOscillator());
      const carrierGain = group.own(context.createGain());
      const stopAt = when + event.length;
      noise.buffer = this.getNoiseBuffer(context);
      noise.loop = true;
      band.type = "bandpass";
      band.frequency.value = 1320;
      band.Q.value = 0.72;
      highpass.type = "highpass";
      highpass.frequency.value = 390;
      envelope.gain.setValueAtTime(0.0001, when);

      const pulseCount = Math.max(2, Math.round(event.length / 0.17));
      for (let pulse = 0; pulse < pulseCount; pulse += 1) {
        const pulseAt = when + pulse * 0.17;
        if (pulseAt >= stopAt - 0.03) break;
        const amplitude =
          event.phrase * (0.11 + ((pulse * 7) % 5) * 0.018);
        envelope.gain.setValueAtTime(Math.max(0.0001, amplitude), pulseAt);
        envelope.gain.exponentialRampToValueAtTime(
          0.0001,
          Math.min(stopAt, pulseAt + 0.115),
        );
      }

      noise.connect(band);
      band.connect(highpass);
      highpass.connect(envelope);
      envelope.connect(trackGraph.input);
      group.attachSource(noise, when, stopAt, (event.time * 1.31) % 2.1);

      carrier.type = "sine";
      carrier.frequency.setValueAtTime(155, when);
      carrier.frequency.linearRampToValueAtTime(172, stopAt);
      carrierGain.gain.setValueAtTime(0.0001, when);
      carrierGain.gain.linearRampToValueAtTime(0.018, when + 0.22);
      carrier.connect(carrierGain);
      carrierGain.connect(trackGraph.input);
      group.attachSource(carrier, when, stopAt);
      return group.finalize();
    }

    readAnalyser(analyser) {
      if (!analyser) return { peak: 0, rms: 0, data: null };
      const size = analyser.fftSize;
      let data = this.meterBuffers.get(analyser);
      if (!data || data.length !== size) {
        data = new Float32Array(size);
        this.meterBuffers.set(analyser, data);
      }
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      let sum = 0;
      for (let index = 0; index < data.length; index += 1) {
        const value = data[index];
        const absolute = Math.abs(value);
        if (absolute > peak) peak = absolute;
        sum += value * value;
      }
      return {
        peak,
        rms: Math.sqrt(sum / Math.max(1, data.length)),
        data,
      };
    }

    getTrackMeter(trackId) {
      const analyser = this.graph && this.graph.tracks[trackId]
        ? this.graph.tracks[trackId].analyser
        : null;
      const reading = this.readAnalyser(analyser);
      return {
        peak: reading.peak,
        rms: reading.rms,
        peakDb: reading.peak > 0 ? gainToDb(reading.peak) : -Infinity,
        rmsDb: reading.rms > 0 ? gainToDb(reading.rms) : -Infinity,
        overload: reading.peak >= OVERLOAD_LINEAR,
      };
    }

    getMasterMeter() {
      const analyser = this.graph ? this.graph.masterAnalyser : null;
      const reading = this.readAnalyser(analyser);
      return {
        peak: reading.peak,
        rms: reading.rms,
        peakDb: reading.peak > 0 ? gainToDb(reading.peak) : -Infinity,
      };
    }

    getWaveform(trackId, points = 36) {
      const analyser = this.graph && this.graph.tracks[trackId]
        ? this.graph.tracks[trackId].analyser
        : null;
      if (!analyser) return new Array(points).fill(0);
      const reading = this.readAnalyser(analyser);
      if (!reading.data) return new Array(points).fill(0);
      const values = [];
      const bucket = Math.max(1, Math.floor(reading.data.length / points));
      for (let index = 0; index < points; index += 1) {
        let selected = 0;
        const start = index * bucket;
        for (let offset = 0; offset < bucket; offset += 1) {
          const value = reading.data[start + offset] || 0;
          if (Math.abs(value) > Math.abs(selected)) selected = value;
        }
        values.push(selected);
      }
      return values;
    }

    getOutputPeak() {
      const reading = this.readAnalyser(
        this.graph ? this.graph.masterAnalyser : null,
      );
      return reading.peak;
    }

    getCompressorReduction() {
      if (!this.graph || !this.settings.compressor.enabled) return 0;
      if (this.graph.routing === "preview") return 0;
      return Math.abs(this.graph.compressor.reduction || 0);
    }

    getStatus() {
      const nodeBreakdown = {};
      for (const node of this.activeNodes) {
        const trackId = node.__mixTrackId || "bus";
        nodeBreakdown[trackId] = (nodeBreakdown[trackId] || 0) + 1;
      }
      return {
        playing: this.playing,
        position: this.getPosition(),
        duration: this.duration,
        activeNodes: this.activeNodes.size,
        pendingSources: this.sourceRecords.size,
        listeners: this.listenerRecords.length,
        destroyedNodes: this.destroyedNodes,
        contextState: this.ctx ? this.ctx.state : "uninitialized",
        schedulerState: this.schedulerState,
        schedulerDropouts: this.schedulerDropouts,
        inputInterrupted: this.inputInterrupted,
        routing: this.graph ? this.graph.routing : "idle",
        startCount: this.startCount,
        sampleRate: this.ctx ? this.ctx.sampleRate : this.sampleRate,
        nodeBreakdown,
        lastError: this.lastError ? this.lastError.message : null,
      };
    }

    async renderOffline(settings, compressorEnabled) {
      const snapshot = clone(settings);
      snapshot.compressor.enabled = Boolean(compressorEnabled);
      const length = Math.round(this.duration * SAMPLE_RATE);
      const OfflineContext =
        window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OfflineContext) throw new Error("当前浏览器不支持离线音频渲染");
      const context = new OfflineContext(2, length, SAMPLE_RATE);
      const graph = this.buildGraph(context, snapshot, null);
      for (const event of this.events) {
        this.scheduleEvent(context, graph, event, event.time, null, false);
      }
      return context.startRendering();
    }

    analyzeBuffer(buffer, compressorSettings) {
      const channels = [];
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        channels.push(buffer.getChannelData(channel));
      }
      const truePeak = calculateTruePeak(channels);
      const loudness = calculateIntegratedLoudness(channels, buffer.sampleRate);
      const gainReduction = estimateGainReduction(
        channels,
        buffer.sampleRate,
        compressorSettings,
      );
      return {
        duration: round(buffer.duration, 4),
        sampleRate: buffer.sampleRate,
        channels: buffer.numberOfChannels,
        peakLinear: truePeak,
        peakDb: truePeak > 0 ? round(gainToDb(truePeak), 2) : -Infinity,
        loudness: Number.isFinite(loudness) ? round(loudness, 2) : -Infinity,
        gainReduction: round(gainReduction, 2),
      };
    }

    async buildComparison(settings = this.settings) {
      const snapshot = clone(settings);
      const bypassBuffer = await this.renderOffline(snapshot, false);
      const compressedBuffer = await this.renderOffline(snapshot, true);
      const bypass = this.analyzeBuffer(bypassBuffer, snapshot.compressor);
      const compressed = this.analyzeBuffer(
        compressedBuffer,
        snapshot.compressor,
      );
      const bypassChannels = [];
      for (
        let channel = 0;
        channel < bypassBuffer.numberOfChannels;
        channel += 1
      ) {
        bypassChannels.push(bypassBuffer.getChannelData(channel));
      }
      bypass.gainReduction = 0;
      compressed.gainReduction = round(
        estimateGainReduction(
          bypassChannels,
          bypassBuffer.sampleRate,
          snapshot.compressor,
        ),
        2,
      );
      const result = {
        bypass,
        compressed,
        peakDelta: round(compressed.peakDb - bypass.peakDb, 2),
        loudnessDelta: round(compressed.loudness - bypass.loudness, 2),
        measuredAt: new Date().toISOString(),
      };
      this.lastAnalysis = result;
      return result;
    }

    async exportWav(settings = this.settings) {
      const snapshot = clone(settings);
      const buffer = await this.renderOffline(
        snapshot,
        snapshot.compressor.enabled,
      );
      const channels = [];
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        channels.push(buffer.getChannelData(channel));
      }
      const analysis = this.analyzeBuffer(buffer, snapshot.compressor);
      const blob = encodeWav(channels, buffer.sampleRate, 32);
      const meta = {
        ...analysis,
        bytes: blob.size,
        compressorEnabled: snapshot.compressor.enabled,
        format: "WAV / IEEE float 32-bit",
      };
      this.lastExportMeta = meta;
      return { blob, meta };
    }
  }

  function calculateTruePeak(channels) {
    let peak = 0;
    for (const samples of channels) {
      for (let index = 0; index < samples.length; index += 1) {
        const absolute = Math.abs(samples[index]);
        if (absolute > peak) peak = absolute;
      }
      for (let index = 1; index < samples.length - 2; index += 1) {
        const p0 = samples[index - 1];
        const p1 = samples[index];
        const p2 = samples[index + 1];
        const p3 = samples[index + 2];
        for (let phase = 1; phase < 4; phase += 1) {
          const x = phase / 4;
          const value =
            p1 +
            0.5 *
              x *
              (p2 -
                p0 +
                x *
                  (2 * p0 -
                    5 * p1 +
                    4 * p2 -
                    p3 +
                    x * (3 * (p1 - p2) + p3 - p0)));
          const absolute = Math.abs(value);
          if (absolute > peak) peak = absolute;
        }
      }
    }
    return peak;
  }

  function applyBiquad(samples, coefficients) {
    const { b0, b1, b2, a1, a2 } = coefficients;
    const output = new Float32Array(samples.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const x0 = samples[index];
      const y0 =
        b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      output[index] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    return output;
  }

  function calculateIntegratedLoudness(channels, sampleRate) {
    const shelf = {
      b0: 1.53512485958697,
      b1: -2.69169618940638,
      b2: 1.19839281085285,
      a1: -1.69065929318241,
      a2: 0.73248077421585,
    };
    const highpass = {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: -1.99004745483398,
      a2: 0.99007225036621,
    };
    const weighted = channels.map((samples) =>
      applyBiquad(applyBiquad(samples, shelf), highpass),
    );
    const blockSize = Math.round(sampleRate * 0.4);
    const hop = Math.round(sampleRate * 0.1);
    const energies = [];
    for (let start = 0; start + blockSize <= weighted[0].length; start += hop) {
      let energy = 0;
      for (const samples of weighted) {
        let sum = 0;
        for (let offset = 0; offset < blockSize; offset += 1) {
          const value = samples[start + offset];
          sum += value * value;
        }
        energy += sum / blockSize;
      }
      const loudness = -0.691 + 10 * Math.log10(Math.max(energy, 1e-12));
      energies.push({ energy, loudness });
    }
    const absoluteGated = energies.filter((block) => block.loudness >= -70);
    if (absoluteGated.length === 0) return -Infinity;
    const absoluteMean =
      absoluteGated.reduce((sum, block) => sum + block.energy, 0) /
      absoluteGated.length;
    const relativeGate =
      -0.691 + 10 * Math.log10(Math.max(absoluteMean, 1e-12)) - 10;
    const relativeGated = absoluteGated.filter(
      (block) => block.loudness >= relativeGate,
    );
    if (relativeGated.length === 0) return -Infinity;
    const mean =
      relativeGated.reduce((sum, block) => sum + block.energy, 0) /
      relativeGated.length;
    return -0.691 + 10 * Math.log10(Math.max(mean, 1e-12));
  }

  function estimateGainReduction(channels, sampleRate, compressor) {
    if (!compressor || !compressor.enabled) return 0;
    if (!channels.length) return 0;
    const blockSize = Math.max(1, Math.round(sampleRate * 0.02));
    let maximum = 0;
    for (
      let start = 0;
      start + blockSize <= channels[0].length;
      start += blockSize
    ) {
      let energy = 0;
      for (const samples of channels) {
        let sum = 0;
        for (let offset = 0; offset < blockSize; offset += 1) {
          const value = samples[start + offset];
          sum += value * value;
        }
        energy += sum / blockSize;
      }
      const rms = Math.sqrt(energy / channels.length);
      if (rms <= 0) continue;
      const inputDb = 20 * Math.log10(rms);
      const reduction = Math.abs(staticGainReductionDb(inputDb, compressor));
      if (reduction > maximum) maximum = reduction;
    }
    return maximum;
  }

  function encodeWav(channels, sampleRate, bitDepth = 32) {
    const channelCount = channels.length;
    const frameCount = channels[0] ? channels[0].length : 0;
    const normalizedDepth = [16, 24, 32].includes(bitDepth) ? bitDepth : 32;
    const bytesPerSample = normalizedDepth / 8;
    const blockAlign = channelCount * bytesPerSample;
    const dataSize = frameCount * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    const writeText = (offset, text) => {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index));
      }
    };

    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, normalizedDepth === 32 ? 3 : 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, normalizedDepth, true);
    writeText(36, "data");
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const value = channels[channel][frame] || 0;
        if (normalizedDepth === 32) {
          view.setFloat32(offset, value, true);
        } else if (normalizedDepth === 24) {
          const sample = Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608)));
          view.setUint8(offset, sample & 0xff);
          view.setUint8(offset + 1, (sample >> 8) & 0xff);
          view.setUint8(offset + 2, (sample >> 16) & 0xff);
        } else {
          const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
          view.setInt16(offset, sample, true);
        }
        offset += bytesPerSample;
      }
    }
    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  window.MixEngine = MixEngine;
  window.MIX04 = {
    MixEngine,
    TRACK_DEFINITIONS,
    DEFAULT_COMPRESSOR,
    defaultSettings,
    defaultTracks,
    dbToGain,
    gainToDb,
    formatPan,
    staticGainReductionDb,
    clamp,
    round,
    softClip,
  };
})();
