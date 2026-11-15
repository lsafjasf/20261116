import { SCENE_HEIGHT, SCENE_WIDTH } from "./scenarios.js";

export class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.width = 0;
    this.height = 0;
    this.scale = 1;
    this.dpr = 1;
  }

  resize() {
    const bounds = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, bounds.width);
    this.height = Math.max(1, bounds.height);
    const pixelWidth = Math.round(this.width * this.dpr);
    const pixelHeight = Math.round(this.height * this.dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.scale = Math.min(this.width / SCENE_WIDTH, this.height / SCENE_HEIGHT);
  }

  toScene(clientX, clientY) {
    const bounds = this.canvas.getBoundingClientRect();
    const offsetX = (this.width - SCENE_WIDTH * this.scale) / 2;
    const offsetY = (this.height - SCENE_HEIGHT * this.scale) / 2;
    return {
      x: (clientX - bounds.left - offsetX) / this.scale,
      y: (clientY - bounds.top - offsetY) / this.scale
    };
  }

  draw(objects, contacts, selectedId, cellSize) {
    const context = this.context;
    const contactIds = new Set();
    for (const contact of contacts) {
      contactIds.add(contact.a);
      contactIds.add(contact.b);
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = "#061019";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const offsetX = (this.width - SCENE_WIDTH * this.scale) / 2;
    const offsetY = (this.height - SCENE_HEIGHT * this.scale) / 2;
    const unit = this.dpr * this.scale;
    context.setTransform(unit, 0, 0, unit, offsetX * this.dpr, offsetY * this.dpr);
    this.drawBackdrop(context, cellSize);

    context.save();
    context.beginPath();
    context.rect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
    context.clip();

    const selected = [];
    for (const object of objects) {
      if (object.id === selectedId) {
        selected.push(object);
        continue;
      }
      this.drawObject(context, object, contactIds.has(object.id), false);
    }
    for (const object of selected) {
      this.drawObject(context, object, contactIds.has(object.id), true);
    }
    context.restore();
  }

  drawBackdrop(context, cellSize) {
    const gradient = context.createRadialGradient(600, 380, 30, 600, 380, 760);
    gradient.addColorStop(0, "#0b1b26");
    gradient.addColorStop(0.62, "#08131d");
    gradient.addColorStop(1, "#050a10");
    context.fillStyle = gradient;
    context.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);

    const size = Math.max(3, cellSize);
    context.lineWidth = 0.7 / this.scale;
    for (let x = 0; x <= SCENE_WIDTH; x += size) {
      const major = Math.round(x / size) % 4 === 0;
      context.strokeStyle = major ? "rgba(105, 147, 174, 0.12)" : "rgba(95, 137, 164, 0.05)";
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, SCENE_HEIGHT);
      context.stroke();
    }
    for (let y = 0; y <= SCENE_HEIGHT; y += size) {
      const major = Math.round(y / size) % 4 === 0;
      context.strokeStyle = major ? "rgba(105, 147, 174, 0.11)" : "rgba(95, 137, 164, 0.045)";
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(SCENE_WIDTH, y);
      context.stroke();
    }

    context.strokeStyle = "rgba(111, 155, 181, 0.2)";
    context.lineWidth = 1 / this.scale;
    context.strokeRect(0.5, 0.5, SCENE_WIDTH - 1, SCENE_HEIGHT - 1);
  }

  drawObject(context, object, contacting, selected) {
    context.save();
    context.translate(object.x, object.y);
    if (object.shape === "circle") {
      this.drawCircle(context, object, contacting, selected);
    } else {
      context.rotate(object.angle);
      this.drawRectangle(context, object, contacting, selected);
    }
    context.restore();
  }

  drawCircle(context, object, contacting, selected) {
    const radius = Math.max(object.radius, 0.4);
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.fillStyle = `hsla(${object.hue}, 72%, 55%, ${contacting ? 0.86 : 0.7})`;
    context.fill();

    context.lineWidth = (contacting ? 1.7 : 0.8) / Math.max(this.scale, 0.35);
    context.strokeStyle = contacting
      ? "rgba(255, 100, 124, 0.94)"
      : "rgba(177, 239, 234, 0.32)";
    if (contacting) {
      context.shadowColor = "rgba(255, 72, 106, 0.9)";
      context.shadowBlur = 7 / this.scale;
    }
    context.stroke();
    context.shadowBlur = 0;

    if (radius > 7) {
      context.beginPath();
      context.arc(-radius * 0.27, -radius * 0.3, radius * 0.18, 0, Math.PI * 2);
      context.fillStyle = "rgba(235, 255, 252, 0.15)";
      context.fill();
    }
    if (selected) this.drawSelectionRing(context, radius + 3);
  }

  drawRectangle(context, object, contacting, selected) {
    const width = Math.max(object.width, 0.2);
    const height = Math.max(object.height, 0.2);
    const left = -width / 2;
    const top = -height / 2;
    context.fillStyle = `hsla(${object.hue}, 78%, 57%, ${contacting ? 0.82 : 0.65})`;
    context.fillRect(left, top, width, height);

    context.lineWidth = (contacting ? 1.7 : 0.8) / Math.max(this.scale, 0.35);
    context.strokeStyle = contacting
      ? "rgba(255, 100, 124, 0.96)"
      : "rgba(255, 223, 187, 0.32)";
    if (contacting) {
      context.shadowColor = "rgba(255, 72, 106, 0.9)";
      context.shadowBlur = 7 / this.scale;
    }
    context.strokeRect(left, top, width, height);
    context.shadowBlur = 0;

    if (width > 16 && height > 9) {
      context.fillStyle = "rgba(255, 250, 231, 0.09)";
      context.fillRect(left + 2, top + 2, width - 4, Math.max(2, height * 0.2));
    }
    if (selected) {
      const radius = Math.hypot(width, height) / 2 + 3;
      this.drawSelectionRing(context, radius);
    }
  }

  drawSelectionRing(context, radius) {
    context.save();
    context.setLineDash([5 / this.scale, 4 / this.scale]);
    context.lineWidth = 1.5 / this.scale;
    context.strokeStyle = "rgba(255, 255, 255, 0.92)";
    context.beginPath();
    context.arc(0, 0, radius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

export function drawSparkline(canvas, samples, limit = 24) {
  const context = canvas.getContext("2d");
  const width = canvas.clientWidth || 280;
  const height = 36;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  const values = samples.slice(-limit);
  const maximum = Math.max(16.7, ...values);
  const step = width / Math.max(1, limit - 1);
  context.strokeStyle = "rgba(77, 227, 179, 0.22)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height - 3);
  context.lineTo(width, height - 3);
  context.stroke();
  if (values.length === 0) return;

  const points = values.map((value, index) => ({
    x: index * step,
    y: height - 3 - Math.min(1, value / maximum) * (height - 7)
  }));
  context.beginPath();
  context.moveTo(0, height - 3);
  for (const point of points) context.lineTo(point.x, point.y);
  context.lineTo(points.at(-1).x, height - 3);
  context.closePath();
  context.fillStyle = "rgba(77, 227, 179, 0.08)";
  context.fill();
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.strokeStyle = "#4de3b3";
  context.lineWidth = 1.3;
  context.stroke();
}
