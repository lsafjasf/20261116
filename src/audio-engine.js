import { NodeRegistry, buildGraph } from "./render.js";
import { SAMPLE_RATE, sanitizeState } from "./model.js";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function readAnalyserRms(analyser) {
  if (!analyser) {
    return 0;
  }
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export class SpatialMonitorEngine {
  constructor(onUpdate = () => {}) {
    this.onUpdate = onUpdate;
    this.subscribers = new Set();
    this.eventListeners = new Set();
    this.status = "idle";
    this.reason = "等待启动";
    this.context = null;
    this.graph = null;
    this.registry = null;
    this.analyser = null;
    this.endTimer = null;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.lastStopTailRms = null;
    this.lastStopReason = null;
    this.lastStartAt = null;
    this.lastEndAt = null;
    this.destroyed = false;
    this.state = null;
    this.contextListenerRemove = null;
    this.bind(document, "visibilitychange", () => {
      if (document.hidden && this.status === "running") {
        this.inputInterruption("页面进入后台");
      }
    });
    this.bind(window, "pagehide", () => this.inputInterruption("页面离开"));
  }

  bind(target, type, handler, options = {}) {
    target.addEventListener(type, handler, options);
    const remove = () => target.removeEventListener(type, handler, options);
    this.eventListeners.add(remove);
    return remove;
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    listener(this.getDiagnostics());
    return () => this.subscribers.delete(listener);
  }

  notify() {
    const diagnostics = this.getDiagnostics();
    this.onUpdate(diagnostics);
    for (const listener of this.subscribers) {
      listener(diagnostics);
    }
  }

  enqueue(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }

  getPlaybackTime() {
    if (!this.graph || !this.context || this.status !== "running") {
      return 0;
    }
    return Math.max(0, this.context.currentTime - this.graph.startTime);
  }

  getDiagnostics() {
    return {
      status: this.status,
      reason: this.reason,
      activeNodes: this.registry?.size ?? 0,
      activeContexts: this.context && this.context.state !== "closed" ? 1 : 0,
      contextState: this.context?.state ?? "closed",
      listeners: this.eventListeners.size,
      subscribers: this.subscribers.size,
      scheduledSources: this.graph?.oscillators.length ?? 0,
      timerActive: this.endTimer !== null,
      generation: this.generation,
      playbackTime: this.getPlaybackTime(),
      lastStopTailRms: this.lastStopTailRms,
      lastStopReason: this.lastStopReason,
      lastStartAt: this.lastStartAt,
      lastEndAt: this.lastEndAt,
      destroyed: this.destroyed
    };
  }

  start(inputState) {
    if (this.destroyed) {
      return Promise.reject(new Error("音频引擎已销毁"));
    }
    const state = sanitizeState(inputState);
    const token = ++this.generation;
    this.status = "starting";
    this.reason = "正在创建音频节点";
    this.notify();

    return this.enqueue(async () => {
      await this.disposeResources("重新启动", token);
      if (token !== this.generation || this.destroyed) {
        return this.getDiagnostics();
      }

      const context = new AudioContext({
        latencyHint: "interactive",
        sampleRate: Math.min(SAMPLE_RATE, 96_000)
      });
      this.context = context;
      this.state = state;
      const stateListener = () => {
        if (context.state === "interrupted" && this.status === "running") {
          this.inputInterruption("系统音频中断");
        } else {
          this.notify();
        }
      };
      this.contextListenerRemove = this.bind(context, "statechange", stateListener);

      try {
        await context.resume();
      } catch {
        // Browsers may keep the context suspended until the next user gesture.
      }
      if (token !== this.generation || this.destroyed) {
        await context.close().catch(() => {});
        return this.getDiagnostics();
      }

      this.registry = new NodeRegistry();
      const startTime = context.currentTime + 0.06;
      this.graph = buildGraph(context, state, {
        registry: this.registry,
        startTime
      });
      this.analyser = this.registry.adopt(context.createAnalyser(), "tail-analyser");
      this.analyser.fftSize = 1024;
      this.graph.master.connect(this.analyser);
      this.analyser.connect(context.destination);

      this.status = "running";
      this.reason = `${state.format === "binaural" ? "HRTF" : "Quad"} 路径正在播放`;
      this.lastStartAt = new Date().toISOString();
      this.lastEndAt = null;
      this.endTimer = setTimeout(() => {
        this.stop("自然播放结束", "ended");
      }, Math.ceil(state.duration * 1000) + 80);
      this.notify();
      return this.getDiagnostics();
    });
  }

  stop(reason = "手动停止", finalStatus = "stopped") {
    if (this.destroyed) {
      return Promise.resolve(this.getDiagnostics());
    }
    const token = ++this.generation;
    this.status = finalStatus === "ended" ? "ending" : "stopping";
    this.reason = reason;
    this.notify();
    return this.enqueue(async () => {
      await this.disposeResources(reason, token);
      if (token === this.generation) {
        this.status = finalStatus;
        this.reason = reason;
        this.lastEndAt = new Date().toISOString();
        this.notify();
      }
      return this.getDiagnostics();
    });
  }

  inputInterruption(reason = "输入中断") {
    if (this.status !== "running" && this.status !== "starting") {
      return Promise.resolve(this.getDiagnostics());
    }
    this.lastStopReason = "interruption";
    return this.stop(`输入中断：${reason}`, "interrupted");
  }

  async disposeResources(reason, token) {
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    if (!this.context) {
      this.registry?.releaseAll();
      this.registry = null;
      this.graph = null;
      this.analyser = null;
      return;
    }

    const context = this.context;
    const graph = this.graph;
    if (graph && context.state === "running") {
      try {
        const now = context.currentTime;
        graph.master.gain.cancelScheduledValues(now);
        graph.master.gain.setValueAtTime(graph.master.gain.value, now);
        graph.master.gain.linearRampToValueAtTime(0.0001, now + 0.045);
      } catch {
        // The context can transition to closed between the state check and ramp.
      }
      await wait(75);
      this.lastStopTailRms = Number(readAnalyserRms(this.analyser).toExponential(4));
    } else {
      this.lastStopTailRms = 0;
    }

    graph?.dispose();
    this.registry?.releaseAll();
    try {
      this.analyser?.disconnect();
    } catch {
      // Already disconnected with the graph.
    }
    this.analyser = null;
    this.graph = null;
    this.registry = null;
    this.context = null;
    this.contextListenerRemove?.();
    this.eventListeners.delete(this.contextListenerRemove);
    this.contextListenerRemove = null;
    await context.close().catch(() => {});
    this.lastStopReason = reason;
    this.notify();
  }

  destroy() {
    if (this.destroyed) {
      return Promise.resolve(this.getDiagnostics());
    }
    this.destroyed = true;
    const token = ++this.generation;
    this.status = "stopping";
    this.reason = "正在销毁音频节点";
    this.notify();
    return this.enqueue(async () => {
      await this.disposeResources("节点销毁", token);
      for (const remove of this.eventListeners) {
        remove();
      }
      this.eventListeners.clear();
      this.subscribers.clear();
      this.status = "destroyed";
      this.reason = "音频节点与监听器已释放";
      this.lastEndAt = new Date().toISOString();
      this.notify();
      return this.getDiagnostics();
    });
  }
}
