const PATTERN_COLORS = {
  cardioid: "#ff8a5d",
  omnidirectional: "#5db7ff",
  figure8: "#b98aff",
};

export class RoomView {
  constructor(canvas, layout, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.layout = layout;
    this.onChange = onChange;
    this.drag = null;
    this.levels = [0, 0];
    this._bind();
    this.draw();
  }

  setLayout(layout) {
    this.layout = layout;
    this.draw();
  }

  setLevels(levels) {
    this.levels = levels;
    this.draw();
  }

  _toCanvas(p) {
    return { x: p.x * this.canvas.width, y: p.y * this.canvas.height };
  }

  _toNorm(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left) / rect.width, 0.02, 0.98),
      y: clamp((clientY - rect.top) / rect.height, 0.02, 0.98),
    };
  }

  _hit(p) {
    for (const mic of this.layout.mics) {
      const c = this._toCanvas(mic);
      if (Math.hypot(c.x - p.x, c.y - p.y) < 18) return { kind: "mic", id: mic.id };
    }
    for (const [name, src] of Object.entries(this.layout.sources)) {
      const c = this._toCanvas(src);
      if (Math.hypot(c.x - p.x, c.y - p.y) < 15) return { kind: "source", id: name };
    }
    return null;
  }

  _bind() {
    this.canvas.addEventListener("pointerdown", (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const hit = this._hit({
        x: ((event.clientX - rect.left) / rect.width) * this.canvas.width,
        y: ((event.clientY - rect.top) / rect.height) * this.canvas.height,
      });
      if (!hit) return;
      this.drag = hit;
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      const p = this._toNorm(event.clientX, event.clientY);
      this.onChange(this.drag.kind, this.drag.id, { position: p });
    });
    const end = () => {
      this.drag = null;
    };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    this.canvas.addEventListener(
      "wheel",
      (event) => {
        const rect = this.canvas.getBoundingClientRect();
        const hit = this._hit({
          x: ((event.clientX - rect.left) / rect.width) * this.canvas.width,
          y: ((event.clientY - rect.top) / rect.height) * this.canvas.height,
        });
        if (!hit || hit.kind !== "mic") return;
        event.preventDefault();
        const mic = this.layout.mics.find((m) => m.id === hit.id);
        const gain = clamp(mic.gain + (event.deltaY < 0 ? 0.08 : -0.08), 0, 2.5);
        this.onChange("mic", hit.id, { gain: Number(gain.toFixed(2)) });
      },
      { passive: false }
    );
  }

  draw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#171c23";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this._drawGrid();
    this._drawSources();
    this._drawMics();
    this._drawTitle();
  }

  _drawGrid() {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = (i / 10) * this.canvas.width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.canvas.height);
      ctx.stroke();
    }
  }

  _drawTitle() {
    const ctx = this.ctx;
    ctx.fillStyle = "#93a0af";
    ctx.font = "12px system-ui";
    ctx.fillText("房间俯视图（拖拽定位 · 麦克风上滚轮调增益）", 12, 20);
  }

  _drawSources() {
    const meta = {
      rain: { label: "雨", color: "#6fc3ff", shape: "drop" },
      wind: { label: "风", color: "#7ee0c0", shape: "wave" },
      voice: { label: "人声", color: "#ffd166", shape: "circle" },
    };
    for (const [name, src] of Object.entries(this.layout.sources)) {
      if (!src.enabled) continue;
      const c = this._toCanvas(src);
      const info = meta[name];
      this.ctx.fillStyle = info.color;
      this.ctx.beginPath();
      this.ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.fillStyle = "#14171c";
      this.ctx.font = "bold 11px system-ui";
      this.ctx.textAlign = "center";
      this.ctx.fillText(info.label, c.x, c.y + 4);
      this.ctx.textAlign = "left";
    }
  }

  _drawMics() {
    for (const mic of this.layout.mics) {
      const c = this._toCanvas(mic);
      const color = PATTERN_COLORS[mic.pattern];
      this._drawPattern(c, mic, color);
      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      this.ctx.arc(c.x, c.y, 7, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.strokeStyle = "#fff";
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();
      this.ctx.fillStyle = "#e6e9ee";
      this.ctx.font = "11px system-ui";
      this.ctx.fillText(`${mic.label.split(" ")[0]} ×${mic.gain.toFixed(2)}`, c.x + 10, c.y - 10);
    }
  }

  _drawPattern(c, mic, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(mic.angle);
    ctx.strokeStyle = color;
    ctx.fillStyle = color + "22";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const steps = 64;
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      let r;
      if (mic.pattern === "cardioid") r = 0.5 * (1 + Math.cos(theta));
      else if (mic.pattern === "figure8") r = Math.abs(Math.cos(theta));
      else r = 1;
      const radius = 34 * r + 4;
      const x = Math.cos(theta) * radius;
      const y = Math.sin(theta) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function drawMeter(canvas, levels, state) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#1d222a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const labels = ["L", "R"];
  levels.forEach((level, idx) => {
    const y = 18 + idx * 32;
    ctx.fillStyle = "#93a0af";
    ctx.font = "12px system-ui";
    ctx.fillText(labels[idx], 12, y + 12);
    ctx.fillStyle = "#2c333d";
    ctx.fillRect(34, y, canvas.width - 60, 18);
    const db = level <= 0 ? 0 : Math.min(1, (20 * Math.log10(level) + 60) / 60);
    const grad = ctx.createLinearGradient(34, 0, canvas.width - 26, 0);
    grad.addColorStop(0, "#54d18b");
    grad.addColorStop(0.75, "#ffd166");
    grad.addColorStop(1, "#ff5d5d");
    ctx.fillStyle = state === "idle" ? "#3a424d" : grad;
    ctx.fillRect(34, y, (canvas.width - 60) * db, 18);
  });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
