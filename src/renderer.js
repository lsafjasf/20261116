const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (a, b, amount) => a + (b - a) * amount;

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export class StageRenderer {
  constructor(canvas, game, audio) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.game = game;
    this.audio = audio;
    this.particles = [];
    this.bursts = [];
    this.trackLines = 2;
    this.lastFrame = performance.now();
    this.random = makeRandom(game.seed);
    this.resize = this.resize.bind(this);
    this._resizeObserver = new ResizeObserver(this.resize);
    this._resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    this.width = Math.max(320, rect.width);
    this.height = Math.max(360, rect.height);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  reset(seed = this.game.seed) {
    this.particles = [];
    this.bursts = [];
    this.random = makeRandom(seed);
    this.lastFrame = performance.now();
  }

  burst(kind, lane, strength = 1) {
    if (this.particles.length > 320) return;
    const count = kind === "miss" ? 24 : 13;
    for (let index = 0; index < count; index += 1) {
      const angle = this.random() * TAU;
      const speed = (0.045 + this.random() * 0.14) * strength;
      this.particles.push({
        lane,
        x: 0.5 + (this.random() - 0.5) * 0.05,
        y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 0.03,
        life: 0.45 + this.random() * 0.55,
        age: 0,
        size: 1.5 + this.random() * 3.2,
        kind
      });
    }
    if (kind === "miss") {
      this.bursts.push({ lane, age: 0, life: 0.8, slices: 7 });
    }
  }

  _layout() {
    const left = this.width * 0.34;
    const right = this.width * 0.66;
    const top = this.height * 0.14;
    const judge = this.height * 0.78;
    return { left, right, top, judge, rails: [left, right] };
  }

  _drawBackdrop(time, snapshot, layout) {
    const ctx = this.context;
    const { width, height } = this;
    const gradient = ctx.createRadialGradient(width / 2, height * 0.56, 40, width / 2, height * 0.5, width * 0.7);
    gradient.addColorStop(0, "rgba(19, 27, 54, 0.92)");
    gradient.addColorStop(0.5, "rgba(8, 12, 30, 0.97)");
    gradient.addColorStop(1, "#050712");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.strokeStyle = "rgba(126, 157, 224, 0.075)";
    ctx.lineWidth = 1;
    const drift = (time * 0.01) % 36;
    for (let x = -height; x < width + height; x += 36) {
      ctx.beginPath();
      ctx.moveTo(x + drift, 0);
      ctx.lineTo(x - height + drift, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += 36) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();

    const horizon = ctx.createLinearGradient(0, height * 0.36, 0, height * 0.7);
    horizon.addColorStop(0, "rgba(62, 225, 255, 0)");
    horizon.addColorStop(0.55, snapshot.focus === 0
      ? "rgba(54, 226, 255, 0.08)"
      : "rgba(255, 78, 190, 0.08)");
    horizon.addColorStop(1, "rgba(62, 225, 255, 0)");
    ctx.fillStyle = horizon;
    ctx.fillRect(layout.left - 130, height * 0.34, layout.right - layout.left + 260, height * 0.4);
  }

  _drawRails(time, snapshot, layout) {
    const ctx = this.context;
    const colors = ["#43e7ff", "#ff55bd"];
    layout.rails.forEach((x, lane) => {
      const focused = snapshot.focus === lane;
      ctx.save();
      ctx.shadowBlur = focused ? 28 : 7;
      ctx.shadowColor = colors[lane];
      ctx.strokeStyle = focused ? colors[lane] : `${colors[lane]}88`;
      ctx.lineWidth = focused ? 3.2 : 1.4;
      ctx.beginPath();
      ctx.moveTo(x, layout.top - 30);
      ctx.lineTo(x, layout.judge + 34);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.setLineDash([3, 14]);
      ctx.lineDashOffset = -time * (focused ? 0.09 : 0.03);
      ctx.strokeStyle = `${colors[lane]}55`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, layout.top);
      ctx.lineTo(x, layout.judge);
      ctx.stroke();
      ctx.restore();

      if (focused) {
        const pulse = 0.5 + Math.sin(time * 0.005) * 0.15;
        const aura = ctx.createLinearGradient(x - 42, 0, x + 42, 0);
        aura.addColorStop(0, "transparent");
        aura.addColorStop(0.5, `${colors[lane]}${Math.round(pulse * 45).toString(16).padStart(2, "0")}`);
        aura.addColorStop(1, "transparent");
        ctx.fillStyle = aura;
        ctx.fillRect(x - 42, layout.top, 84, layout.judge - layout.top + 42);
      }
    });

    const judgeGradient = ctx.createLinearGradient(layout.left - 90, 0, layout.right + 90, 0);
    judgeGradient.addColorStop(0, "rgba(67, 231, 255, 0.05)");
    judgeGradient.addColorStop(0.5, "rgba(224, 234, 255, 0.55)");
    judgeGradient.addColorStop(1, "rgba(255, 85, 189, 0.05)");
    ctx.strokeStyle = judgeGradient;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(layout.left - 90, layout.judge);
    ctx.lineTo(layout.right + 90, layout.judge);
    ctx.stroke();
    ctx.fillStyle = "rgba(224, 234, 255, 0.42)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("JUDGEMENT PLANE", this.width / 2, layout.judge + 22);
  }

  _notePosition(note, snapshot, layout) {
    const preview = 2_800;
    const delta = note.timeMs - snapshot.songMs;
    const progress = clamp(1 - delta / preview, 0, 1);
    const targetX = layout.rails[note.lane];
    const originX = note.cross ? layout.rails[1 - note.lane] : targetX + (note.lane ? 12 : -12);
    const curve = Math.sin(progress * Math.PI) * (note.cross ? 0.09 : 0.015);
    const x = lerp(originX, targetX, progress) + (note.lane ? 1 : -1) * curve * this.width;
    const y = lerp(layout.top, layout.judge, progress);
    return { x, y, progress };
  }

  _drawNotes(snapshot, layout) {
    const ctx = this.context;
    const colors = ["#43e7ff", "#ff55bd"];
    for (let index = 0; index < this.game.notes.length; index += 1) {
      const note = this.game.notes[index];
      const result = this.game.results[index];
      const delta = note.timeMs - snapshot.songMs;
      if (delta > 2_800 || delta < -300) continue;
      if (result && result.kind !== "miss") continue;
      const position = this._notePosition(note, snapshot, layout);
      const color = colors[note.lane];

      if (note.cross) {
        ctx.save();
        ctx.strokeStyle = `${color}44`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        const start = this._notePosition({ ...note, timeMs: note.timeMs - 420 }, snapshot, layout);
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(this.width / 2, position.y + 24, position.x, position.y);
        ctx.stroke();
        ctx.restore();
      }

      const focused = note.lane === snapshot.focus;
      const radius = (focused ? 8 : 6) * (0.85 + position.progress * 0.35);
      ctx.save();
      ctx.shadowBlur = focused ? 22 : 9;
      ctx.shadowColor = color;
      ctx.fillStyle = result ? "#ff7c65" : color;
      ctx.globalAlpha = result ? 0.45 : 0.95;
      ctx.beginPath();
      if (note.cross) {
        ctx.translate(position.x, position.y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
      } else {
        ctx.arc(position.x, position.y, radius, 0, TAU);
        ctx.fill();
      }
      ctx.restore();

      if (position.progress > 0.58) {
        ctx.strokeStyle = `${color}${focused ? "88" : "44"}`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(position.x, position.y, radius + 8 + Math.sin(position.progress * 9) * 2, 0, TAU);
        ctx.stroke();
      }
    }
  }

  _drawSpectrum(snapshot, layout, time) {
    const ctx = this.context;
    const colors = ["#43e7ff", "#ff55bd"];
    layout.rails.forEach((railX, lane) => {
      const spectrum = this.audio.spectrum(lane);
      if (!spectrum) return;
      const baseY = layout.judge + 44;
      const maxHeight = this.height * 0.17;
      const barWidth = Math.max(2, Math.min(6, this.width * 0.006));
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = colors[lane];
      spectrum.forEach((value, index) => {
        const x = railX - (spectrum.length * (barWidth + 2)) / 2 + index * (barWidth + 2);
        const shimmer = 0.65 + Math.sin(time * 0.004 + index * 0.7) * 0.18;
        const height = Math.max(1.5, value * maxHeight * shimmer);
        ctx.globalAlpha = 0.2 + value * 0.78;
        ctx.fillRect(x, baseY - height, barWidth, height);
        if (value > 0.55) {
          ctx.fillRect(x, baseY - height - 4, barWidth, 2);
        }
      });
      ctx.restore();
    });
  }

  _drawBlur(snapshot, layout, time) {
    if (!snapshot.blurActive) return;
    const ctx = this.context;
    const lane = snapshot.blurLane;
    const rail = layout.rails[lane];
    const colors = ["#43e7ff", "#ff55bd"];
    const age = Math.max(0, snapshot.songMs - (snapshot.blurUntil - 1_200));
    const strength = clamp(1 - age / 1_200, 0, 1);
    ctx.save();
    ctx.filter = `blur(${(4 + strength * 5).toFixed(1)}px)`;
    ctx.globalAlpha = 0.22 + strength * 0.3;
    ctx.fillStyle = colors[lane];
    for (let slice = 0; slice < 9; slice += 1) {
      const y = layout.top + ((time * 0.045 + slice * 67) % (layout.judge - layout.top));
      const offset = Math.sin(time * 0.02 + slice * 2.1) * (4 + strength * 12);
      ctx.fillRect(rail - 30 + offset, y, 60, 5 + strength * 6);
    }
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "rgba(255, 124, 101, 0.86)";
    ctx.font = "600 10px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText("SIGNAL BLUR", rail, layout.judge + 66);
    ctx.restore();
  }

  _drawBursts(layout, deltaSeconds) {
    const ctx = this.context;
    const colors = ["#43e7ff", "#ff55bd"];
    for (const burst of this.bursts) {
      burst.age += deltaSeconds;
      const alpha = clamp(1 - burst.age / burst.life, 0, 1);
      ctx.save();
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = "#ff7c65";
      for (let slice = 0; slice < burst.slices; slice += 1) {
        const x = layout.rails[burst.lane] - 50 + slice * 16;
        const y = layout.top + ((slice * 79 + burst.age * 160) % (layout.judge - layout.top));
        ctx.fillStyle = slice % 2 ? "#ff7c65" : colors[burst.lane];
        ctx.fillRect(x, y, 25 + (slice % 3) * 8, 2);
      }
      ctx.restore();
    }
    this.bursts = this.bursts.filter((burst) => burst.age < burst.life);

    for (const particle of this.particles) {
      particle.age += deltaSeconds;
      particle.vy += 0.12 * deltaSeconds;
      particle.x += particle.vx * deltaSeconds;
      particle.y += particle.vy * deltaSeconds;
      const alpha = clamp(1 - particle.age / particle.life, 0, 1);
      const x = layout.rails[particle.lane] + particle.x * this.width;
      const y = layout.judge + particle.y * this.height;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.kind === "miss" ? "#ff7c65" : colors[particle.lane];
      ctx.fillRect(x - particle.size / 2, y - particle.size / 2, particle.size, particle.size);
      ctx.restore();
    }
    this.particles = this.particles.filter((particle) => particle.age < particle.life);
  }

  _drawFocusLock(snapshot, layout, time) {
    const focusedX = layout.rails[snapshot.focus];
    const color = snapshot.focus === 0 ? "#43e7ff" : "#ff55bd";
    const ctx = this.context;
    const pulse = 0.5 + Math.sin(time * 0.006) * 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.18 + pulse * 0.24;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(focusedX, layout.judge, 42 + pulse * 8, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([2, 7]);
    ctx.beginPath();
    ctx.arc(focusedX, layout.judge, 53 + pulse * 4, time * 0.0008, time * 0.0008 + Math.PI * 1.4);
    ctx.stroke();
    ctx.restore();
  }

  render(now = performance.now()) {
    const snapshot = this.game.getSnapshot();
    const layout = this._layout();
    const deltaSeconds = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this._drawBackdrop(now, snapshot, layout);
    this._drawRails(now, snapshot, layout);
    this._drawNotes(snapshot, layout);
    this._drawSpectrum(snapshot, layout, now);
    this._drawFocusLock(snapshot, layout, now);
    this._drawBlur(snapshot, layout, now);
    this._drawBursts(layout, deltaSeconds);

    const low = snapshot.integrity <= 24;
    const vignette = this.context.createRadialGradient(
      this.width / 2,
      this.height / 2,
      this.height * 0.25,
      this.width / 2,
      this.height / 2,
      this.width * 0.7
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, low ? "rgba(80, 8, 26, 0.42)" : "rgba(0, 0, 0, 0.38)");
    this.context.fillStyle = vignette;
    this.context.fillRect(0, 0, this.width, this.height);
  }

  resources() {
    return {
      particles: this.particles.length,
      glitchBursts: this.bursts.length,
      trackLines: this.trackLines,
      notePool: this.game.notes.length,
      canvas: `${this.canvas.width}×${this.canvas.height}`
    };
  }
}
