import { RecordingEngine, DEFAULT_LAYOUT, renderOffline, computePickupWeights, roomVector } from "./engine.js";
import { RoomView, drawMeter } from "./room.js";
import { wavDurationSeconds, encodeWav } from "./wav.js";

const SNAPSHOT_KEY = "field-recorder-snapshot-v1";

class App {
  constructor() {
    this.engine = new RecordingEngine();
    this.canvas = document.getElementById("room");
    this.meterCanvas = document.getElementById("meter");
    this.view = new RoomView(this.canvas, this.engine.layout, (kind, id, change) =>
      this.handleCanvasChange(kind, id, change)
    );
    this.logLines = [];
    this._buildMicControls();
    this._bind();
    this.engine.onStateChange = (state) => this.syncState(state);
    this.engine.onMeter = (levels) => drawMeter(this.meterCanvas, levels, this.engine.state);
    this._statsTimer = window.setInterval(() => this.refreshStats(), 200);
    this.syncState("idle");
    this.refreshStats();
    this.log("工作台就绪");
  }

  log(message) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    this.logLines.push(`${time} ${message}`);
    const el = document.getElementById("log");
    el.textContent = this.logLines.slice(-80).join("\n");
    el.scrollTop = el.scrollHeight;
  }

  _buildMicControls() {
    const wrap = document.getElementById("micControls");
    wrap.innerHTML = "";
    this.engine.layout.mics.forEach((mic, idx) => {
      const card = document.createElement("div");
      card.className = "mic-card";
      card.dataset.id = mic.id;
      card.innerHTML = `
        <div class="name"><span>${mic.label}</span><span class="gain-val">${mic.gain.toFixed(2)}</span></div>
        <div class="meta">x ${mic.x.toFixed(2)} · y ${mic.y.toFixed(2)} · 角度 ${Math.round((mic.angle * 180) / Math.PI)}°</div>
        <label>增益 <input type="range" min="0" max="2.5" step="0.01" value="${mic.gain}" data-role="gain" /></label>
        <label>角度 <input type="range" min="-180" max="180" step="1" value="${Math.round((mic.angle * 180) / Math.PI)}" data-role="angle" /></label>
      `;
      wrap.appendChild(card);
      card.querySelector('[data-role="gain"]').addEventListener("input", (event) => {
        this.patchMic(idx, { gain: Number(event.target.value) });
      });
      card.querySelector('[data-role="angle"]').addEventListener("input", (event) => {
        this.patchMic(idx, { angle: (Number(event.target.value) * Math.PI) / 180 });
      });
    });
  }

  patchMic(idx, patch) {
    try {
      const mics = this.engine.layout.mics.map((mic, i) => (i === idx ? { ...mic, ...patch } : mic));
      this.engine.updateLayout({ mics });
      this.afterLayoutChange();
    } catch (err) {
      this.log(`拒绝调整：${err.message}`);
    }
  }

  handleCanvasChange(kind, id, change) {
    try {
      if (kind === "mic") {
        const mics = this.engine.layout.mics.map((mic) => {
          if (mic.id !== id) return mic;
          return change.position ? { ...mic, ...change.position } : { ...mic, ...change };
        });
        this.engine.updateLayout({ mics });
      } else {
        const sources = {
          ...this.engine.layout.sources,
          [id]: { ...this.engine.layout.sources[id], ...change.position },
        };
        this.engine.updateLayout({ sources });
      }
      this.afterLayoutChange();
    } catch (err) {
      this.log(`拒绝调整：${err.message}`);
    }
  }

  afterLayoutChange() {
    this.view.setLayout(this.engine.layout);
    this._buildMicControls();
    this.refreshPanReadout();
  }

  _bind() {
    document.getElementById("btnStart").addEventListener("click", () => this.start());
    document.getElementById("btnStop").addEventListener("click", () => this.stop());
    document.getElementById("btnClear").addEventListener("click", () => this.clear());
    document.getElementById("btnExport").addEventListener("click", () => this.exportWav());
    document.getElementById("btnSnapshot").addEventListener("click", () => this.saveSnapshot());
    document.getElementById("btnRestore").addEventListener("click", () => this.restoreSnapshot());
    document.getElementById("monitorGain").addEventListener("input", (event) => {
      this.engine.updateLayout({ monitorGain: Number(event.target.value) });
      this.refreshPanReadout();
    });
    for (const name of ["rain", "wind", "voice"]) {
      document.getElementById(`src${cap(name)}`).addEventListener("change", (event) => {
        const sources = {
          ...this.engine.layout.sources,
          [name]: { ...this.engine.layout.sources[name], enabled: event.target.checked },
        };
        this.engine.updateLayout({ sources });
        this.view.draw();
      });
    }
  }

  async start() {
    if (this.engine.hasBuffer) {
      this.log("旧缓冲仍存在：请先清空缓冲再重新录制");
      return;
    }
    try {
      await this.engine.start();
      this.renderBeats(this.engine.beats);
      this.log(`开始录音，节拍点 ${this.engine.beats.length} 个，活动节点 ${this.engine.activeNodes}`);
    } catch (err) {
      this.log(`启动失败：${err.message}`);
      this.syncState("error");
    }
  }

  async stop() {
    const recording = await this.engine.stop();
    this.log(
      `停止并销毁图：残留节点 ${this.engine.activeNodes}、监听器 ${this.engine.activeListeners}、缓冲 ${recording.duration.toFixed(2)}s`
    );
    drawMeter(this.meterCanvas, [0, 0], "idle");
    this.syncState("idle");
  }

  clear() {
    this.engine.clearBuffer();
    this.log("旧缓冲已清空，可以重新录制");
    this.syncState("idle");
  }

  async exportWav() {
    try {
      const blob = this.engine.exportWav();
      const duration = await wavDurationSeconds(blob);
      this.lastExport = { blob, duration };
      this.log(`导出立体声 WAV：${(blob.size / 1024).toFixed(1)} KiB，时长 ${duration.toFixed(3)}s`);
    } catch (err) {
      this.log(`导出失败：${err.message}`);
    }
  }

  saveSnapshot() {
    const snapshot = {
      savedAt: new Date().toISOString(),
      layout: structuredClone(this.engine.layout),
      recordingMeta: this.engine.recordingMeta || null,
      beats: this.engine.beats,
    };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    this.snapshot = snapshot;
    this.log(`快照已保存（${snapshot.layout.mics.length} 支麦克风参数）`);
  }

  restoreSnapshot() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      if (!raw) throw new Error("没有可恢复的快照");
      const snapshot = JSON.parse(raw);
      if (this.engine.state !== "idle") throw new EngineBusy("录音中不能恢复快照");
      this.engine.clearBuffer();
      this.engine.layout = structuredClone(snapshot.layout);
      this.view.setLayout(this.engine.layout);
      this._buildMicControls();
      document.getElementById("monitorGain").value = this.engine.layout.monitorGain;
      for (const name of ["rain", "wind", "voice"]) {
        document.getElementById(`src${cap(name)}`).checked =
          this.engine.layout.sources[name].enabled;
      }
      this.snapshot = snapshot;
      this.refreshPanReadout();
      this.log(`快照已恢复：节拍点 ${snapshot.beats.length} 个`);
    } catch (err) {
      this.log(`恢复失败：${err.message}`);
    }
  }

  renderBeats(beats) {
    const ol = document.getElementById("beatList");
    ol.innerHTML = "";
    beats.forEach((t, i) => {
      const li = document.createElement("li");
      li.textContent = `#${i + 1} @ ${t.toFixed(3)}s`;
      ol.appendChild(li);
    });
  }

  refreshPanReadout() {
    const text = this.engine.layout.mics
      .map((mic) => {
        const pan = Math.max(-1, Math.min(1, (mic.x - 0.5) * 2));
        const side = pan < -0.05 ? "左" : pan > 0.05 ? "右" : "中";
        return `${mic.label.split(" ")[0]}:${side}${Math.abs(pan).toFixed(2)}`;
      })
      .join("  ");
    document.getElementById("panReadout").textContent = text;
  }

  refreshStats() {
    document.getElementById("nodeCount").textContent = this.engine.activeNodes;
    document.getElementById("listenerCount").textContent = this.engine.activeListeners;
    document.getElementById("sampleRate").textContent = this.engine.ctx
      ? this.engine.ctx.sampleRate
      : "-";
    document.getElementById("bufferStatus").textContent = this.engine.hasBuffer
      ? `${this.engine.recording.duration.toFixed(2)}s`
      : "无";
  }

  syncState(state) {
    const pill = document.getElementById("statusPill");
    const running = state === "recording" || state === "running";
    pill.className = `status ${state}`;
    pill.textContent = { idle: "空闲", recording: "录音中", running: "运行中", error: "错误" }[state] || state;
    document.getElementById("btnStart").disabled = running || this.engine.hasBuffer;
    document.getElementById("btnStop").disabled = !running;
    document.getElementById("btnClear").disabled = running || !this.engine.hasBuffer;
    document.getElementById("btnExport").disabled = running || !this.engine.hasBuffer;
    this.refreshStats();
    this.refreshPanReadout();
  }
}

function cap(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
class EngineBusy extends Error {}

window.RecordingWorkbench = {
  App,
  RecordingEngine,
  renderOffline,
  computePickupWeights,
  roomVector,
  DEFAULT_LAYOUT,
  encodeWav,
  wavDurationSeconds,
};
window.addEventListener("DOMContentLoaded", () => {
  window.workbench = new App();
});
