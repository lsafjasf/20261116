import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  SENSOR_RADIUS,
  CELL_SIZE,
  SHIP_RADIUS,
} from "./core/world.js";

const TAU = Math.PI * 2;

const hash32 = (value) => {
  let state = value >>> 0;
  state ^= state >>> 16;
  state = Math.imul(state, 0x7feb352d);
  state ^= state >>> 15;
  state = Math.imul(state, 0x846ca68b);
  return (state ^ (state >>> 16)) >>> 0;
};

const mulberry32 = (seed) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const lerp = (a, b, t) => a + (b - a) * t;

export class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.trail = [];
    this.lastTrailTime = -Infinity;
    this.lastFrameTime = 0;
    this.stars = this.createStars(240);
    this.nodeShapes = new Map();
    this.paused = false;
    this.pauseReason = "manual";
    this.resize = this.resize.bind(this);
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  createStars(count, seed = 913) {
    const random = mulberry32(seed);
    return Array.from({ length: count }, () => ({
      x: random(),
      y: random(),
      depth: 0.12 + random() * 0.78,
      size: 0.35 + random() * 1.5,
      phase: random() * TAU,
    }));
  }

  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.zoom = Math.max(0.48, Math.min(1.05, this.width / 1280, this.height / 760));
  }

  clearTrail() {
    this.trail.length = 0;
    this.lastTrailTime = -Infinity;
  }

  getCamera(sample) {
    return {
      x: sample.x + Math.cos(sample.angle) * 34,
      y: sample.y + Math.sin(sample.angle) * 34,
    };
  }

  drawBackdrop(ctx, sample, camera) {
    for (const star of this.stars) {
      const parallaxX = camera.x * star.depth * 0.075;
      const parallaxY = camera.y * star.depth * 0.075;
      const x = ((star.x * this.width - parallaxX) % this.width + this.width) % this.width;
      const y = ((star.y * this.height - parallaxY) % this.height + this.height) % this.height;
      const twinkle = 0.55 + 0.45 * Math.sin(sample.time * 1.4 + star.phase);
      ctx.fillStyle = `rgba(177, 228, 231, ${0.16 + star.depth * 0.48 * twinkle})`;
      ctx.fillRect(x, y, star.size * star.depth, star.size * star.depth);
    }
  }

  drawWorldGrid(ctx, camera) {
    const viewWidth = this.width / this.zoom;
    const viewHeight = this.height / this.zoom;
    const left = Math.max(0, camera.x - viewWidth / 2);
    const right = Math.min(WORLD_WIDTH, camera.x + viewWidth / 2);
    const top = Math.max(0, camera.y - viewHeight / 2);
    const bottom = Math.min(WORLD_HEIGHT, camera.y + viewHeight / 2);
    const startX = Math.floor(left / CELL_SIZE) * CELL_SIZE;
    const startY = Math.floor(top / CELL_SIZE) * CELL_SIZE;

    ctx.lineWidth = 1 / this.zoom;
    ctx.strokeStyle = "rgba(114, 181, 186, 0.075)";
    ctx.beginPath();
    for (let x = startX; x <= right; x += CELL_SIZE) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = startY; y <= bottom; y += CELL_SIZE) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(124, 231, 223, 0.22)";
    ctx.lineWidth = 1.4 / this.zoom;
    ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  }

  getNodeShape(node) {
    let shape = this.nodeShapes.get(node.id);
    if (shape) return shape;
    const random = mulberry32(hash32(node.shapeSeed));
    const vertices = 7 + (hash32(node.shapeSeed + 1) % 4);
    shape = Array.from({ length: vertices }, (_, index) => {
      const angle = (index / vertices) * TAU;
      const radius = 0.72 + random() * 0.34;
      return {
        x: Math.cos(angle) * node.radius * radius,
        y: Math.sin(angle) * node.radius * radius,
      };
    });
    this.nodeShapes.set(node.id, shape);
    return shape;
  }

  drawNodes(ctx, nodes, sample, camera) {
    const viewWidth = this.width / this.zoom;
    const viewHeight = this.height / this.zoom;
    const margin = 80;
    for (const node of nodes) {
      if (
        node.x < camera.x - viewWidth / 2 - margin ||
        node.x > camera.x + viewWidth / 2 + margin ||
        node.y < camera.y - viewHeight / 2 - margin ||
        node.y > camera.y + viewHeight / 2 + margin
      ) {
        continue;
      }

      const dx = node.x - sample.x;
      const dy = node.y - sample.y;
      const distance = Math.hypot(dx, dy);
      const inSensor = distance <= SENSOR_RADIUS;
      const isNear = distance <= node.radius + SHIP_RADIUS + 7;
      const shape = this.getNodeShape(node);

      ctx.save();
      ctx.translate(node.x, node.y);
      ctx.beginPath();
      shape.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      ctx.fillStyle = isNear ? "rgba(72, 47, 28, 0.9)" : "rgba(11, 25, 31, 0.92)";
      ctx.strokeStyle = isNear
        ? "rgba(255, 180, 92, 0.92)"
        : inSensor
          ? "rgba(124, 231, 223, 0.54)"
          : "rgba(109, 158, 166, 0.25)";
      ctx.lineWidth = (isNear ? 1.8 : 1.1) / this.zoom;
      ctx.fill();
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, node.radius * 0.42, 0, TAU);
      ctx.strokeStyle = inSensor
        ? "rgba(255, 180, 92, 0.3)"
        : "rgba(124, 231, 223, 0.13)";
      ctx.lineWidth = 0.8 / this.zoom;
      ctx.stroke();

      if (inSensor) {
        const sweep = sample.time * 0.8 + node.phase;
        ctx.beginPath();
        ctx.arc(0, 0, node.radius + 4, sweep, sweep + 0.8);
        ctx.strokeStyle = "rgba(124, 231, 223, 0.32)";
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawTrail(ctx, sample, paused) {
    const point = { x: sample.x, y: sample.y, time: sample.time };
    const last = this.trail[this.trail.length - 1];
    if (!paused && (!last || sample.time - last.time >= 0.016)) {
      this.trail.push(point);
      if (this.trail.length > 90) this.trail.shift();
    }
    if (this.trail.length < 2) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    for (let index = 1; index < this.trail.length; index += 1) {
      const a = this.trail[index - 1];
      const b = this.trail[index];
      const progress = index / this.trail.length;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = `rgba(55, 242, 212, ${progress * 0.28})`;
      ctx.lineWidth = (0.5 + progress * 1.8) / this.zoom;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawSensor(ctx, sample) {
    ctx.save();
    ctx.translate(sample.x, sample.y);
    const pulse = 0.5 + Math.sin(sample.time * 2.4) * 0.5;
    const ring = ctx.createRadialGradient(0, 0, 20, 0, 0, SENSOR_RADIUS);
    ring.addColorStop(0, "rgba(55, 242, 212, 0.008)");
    ring.addColorStop(0.82, "rgba(55, 242, 212, 0.015)");
    ring.addColorStop(1, "rgba(55, 242, 212, 0.06)");
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(0, 0, SENSOR_RADIUS, 0, TAU);
    ctx.fill();

    ctx.setLineDash([4 / this.zoom, 13 / this.zoom]);
    ctx.lineDashOffset = -sample.time * 18;
    ctx.strokeStyle = `rgba(124, 231, 223, ${0.1 + pulse * 0.08})`;
    ctx.lineWidth = 1 / this.zoom;
    ctx.beginPath();
    ctx.arc(0, 0, SENSOR_RADIUS, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "rgba(255, 180, 92, 0.2)";
    ctx.beginPath();
    ctx.arc(0, 0, SENSOR_RADIUS + 8 + pulse * 8, -0.12, 0.12);
    ctx.stroke();
    ctx.restore();
  }

  drawShip(ctx, sample, paused) {
    const thrusting = sample.thrusterActive && !paused;
    ctx.save();
    ctx.translate(sample.x, sample.y);
    ctx.rotate(sample.angle);
    ctx.shadowColor = "rgba(55, 242, 212, 0.7)";
    ctx.shadowBlur = 14;

    if (thrusting) {
      const flicker = 0.82 + Math.sin(sample.time * 42) * 0.18;
      const flame = 20 + flicker * 19;
      ctx.beginPath();
      ctx.moveTo(-12, -7);
      ctx.lineTo(-flame, 0);
      ctx.lineTo(-12, 7);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 180, 92, 0.72)";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-10, -3.5);
      ctx.lineTo(-flame * 0.62, 0);
      ctx.lineTo(-10, 3.5);
      ctx.closePath();
      ctx.fillStyle = "rgba(225, 255, 248, 0.9)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(22, 0);
    ctx.lineTo(-5, -10);
    ctx.lineTo(-14, -19);
    ctx.lineTo(-19, -7);
    ctx.lineTo(-14, 0);
    ctx.lineTo(-19, 7);
    ctx.lineTo(-14, 19);
    ctx.lineTo(-5, 10);
    ctx.closePath();
    ctx.fillStyle = "#102b33";
    ctx.strokeStyle = "#8bf4e6";
    ctx.lineWidth = 1.25 / this.zoom;
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-4, -5);
    ctx.lineTo(-4, 5);
    ctx.closePath();
    ctx.fillStyle = "rgba(55, 242, 212, 0.55)";
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(0, 0, 28, -0.34, 0.34);
    ctx.strokeStyle = "rgba(255, 180, 92, 0.38)";
    ctx.lineWidth = 0.9 / this.zoom;
    ctx.stroke();
    ctx.restore();
  }

  drawPausedOverlay(ctx) {
    ctx.save();
    ctx.fillStyle = "rgba(3, 7, 10, 0.36)";
    ctx.fillRect(0, 0, this.width, this.height);
    const centerX = this.width / 2;
    const centerY = this.height * 0.52;
    const lineWidth = Math.min(280, this.width * 0.4);

    ctx.strokeStyle = "rgba(255, 180, 92, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX - lineWidth, centerY - 26);
    ctx.lineTo(centerX - 70, centerY - 26);
    ctx.moveTo(centerX + 70, centerY - 26);
    ctx.lineTo(centerX + lineWidth, centerY - 26);
    ctx.stroke();

    ctx.fillStyle = "rgba(255, 180, 92, 0.92)";
    ctx.textAlign = "center";
    ctx.font = '600 11px "SFMono-Regular", Consolas, monospace';
    ctx.fillText("SIMULATION PAUSED", centerX, centerY);
    ctx.fillStyle = "rgba(220, 235, 240, 0.68)";
    ctx.font = '9px "SFMono-Regular", Consolas, monospace';
    const detail =
      this.pauseReason === "focus"
        ? "FOCUS LOST · PHYSICS TIME FROZEN"
        : "THRUSTER LOCKED · ENGINE OUTPUT ZERO";
    ctx.fillText(detail, centerX, centerY + 22);
    ctx.restore();
  }

  render(sample, { nodes, paused, pauseReason, lastCollision }) {
    const ctx = this.ctx;
    const camera = this.getCamera(sample);
    this.paused = paused;
    this.pauseReason = pauseReason;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawBackdrop(ctx, sample, camera);

    ctx.save();
    ctx.translate(this.width / 2 - camera.x * this.zoom, this.height * 0.53 - camera.y * this.zoom);
    ctx.scale(this.zoom, this.zoom);
    this.drawWorldGrid(ctx, camera);
    this.drawTrail(ctx, sample, paused);
    this.drawNodes(ctx, nodes, sample, camera);
    this.drawSensor(ctx, sample);
    this.drawShip(ctx, sample, paused);
    if (lastCollision) {
      ctx.beginPath();
      ctx.arc(sample.x, sample.y, 36 + Math.sin(sample.time * 30) * 5, 0, TAU);
      ctx.strokeStyle = "rgba(255, 108, 116, 0.5)";
      ctx.lineWidth = 1.2 / this.zoom;
      ctx.stroke();
    }
    ctx.restore();

    if (paused) this.drawPausedOverlay(ctx);
  }
}
