(function (root) {
  "use strict";

  const core = root.LandslideCore;
  const { ANCHORS, SENSOR_TYPES, clamp, round } = core;

  const TAU = Math.PI * 2;
  const ROAD_PATH = [
    { x: 0.29, y: 0.835 },
    { x: 0.48, y: 0.795 },
    { x: 0.71, y: 0.728 },
    { x: 0.88, y: 0.678 },
    { x: 1.02, y: 0.642 },
  ];

  function rgba(hex, alpha) {
    const clean = hex.replace("#", "");
    const value = parseInt(clean.length === 3
      ? clean.split("").map((char) => char + char).join("")
      : clean, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function pointOnPath(path, progress) {
    const distance = clamp(progress, 0, 1) * (path.length - 1);
    const index = Math.min(path.length - 2, Math.floor(distance));
    const local = distance - index;
    const from = path[index];
    const to = path[index + 1];
    return {
      x: from.x + (to.x - from.x) * local,
      y: from.y + (to.y - from.y) * local,
      angle: Math.atan2(to.y - from.y, to.x - from.x),
    };
  }

  class SceneRenderer {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.sim = null;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.hoveredAnchor = null;
      this.activeSensorType = null;
      this.frameTime = 0;
      this.onAnchorClick = options.onAnchorClick || function () {};
      this.onAnchorHover = options.onAnchorHover || function () {};
      this.onPlacementMiss = options.onPlacementMiss || function () {};
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas.parentElement);
      this.bindEvents();
      this.resize();
    }

    bindEvents() {
      this.canvas.addEventListener("pointermove", (event) => {
        const point = this.pointerToNormalized(event);
        const anchor = this.findAnchor(point.x, point.y);
        if (anchor?.id !== this.hoveredAnchor?.id) {
          this.hoveredAnchor = anchor;
          this.canvas.style.cursor = this.activeSensorType
            ? (anchor ? "pointer" : "crosshair")
            : "default";
          this.onAnchorHover(anchor);
        }
      });
      this.canvas.addEventListener("pointerleave", () => {
        this.hoveredAnchor = null;
        this.onAnchorHover(null);
      });
      this.canvas.addEventListener("click", (event) => {
        const point = this.pointerToNormalized(event);
        const anchor = this.findAnchor(point.x, point.y);
        if (this.activeSensorType) {
          if (anchor) this.onAnchorClick(anchor);
          else this.onPlacementMiss();
        }
      });
    }

    pointerToNormalized(event) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      };
    }

    findAnchor(x, y) {
      let match = null;
      let best = 0.085;
      for (const anchor of ANCHORS) {
        const distance = Math.hypot(anchor.x - x, anchor.y - y);
        if (distance < best) {
          best = distance;
          match = anchor;
        }
      }
      return match;
    }

    setSimulation(sim) {
      this.sim = sim;
    }

    setActiveSensor(type) {
      this.activeSensorType = type;
      this.canvas.style.cursor = type ? "crosshair" : "default";
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.width = Math.max(320, rect.width);
      this.height = Math.max(240, rect.height);
      this.dpr = Math.min(2, root.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    x(value) { return value * this.width; }
    y(value) { return value * this.height; }

    render(deltaMs) {
      if (!this.sim) return;
      this.frameTime += deltaMs;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.width, this.height);
      this.drawSky(ctx);
      this.drawRainHaze(ctx);
      this.drawMountains(ctx);
      this.drawSlope(ctx);
      this.drawRoad(ctx);
      this.drawRain(ctx);
      this.drawVehicles(ctx);
      this.drawAnchorsAndSensors(ctx);
      this.drawAtmosphere(ctx);
    }

    drawSky(ctx) {
      const sim = this.sim;
      const danger = clamp((0.6 - sim.trueState.stability) / 0.45, 0, 1);
      const storm = clamp(sim.env.rain / 34, 0, 1);
      const sky = ctx.createLinearGradient(0, 0, 0, this.height * 0.75);
      sky.addColorStop(0, danger > 0.65 ? "#2a1715" : "#101f22");
      sky.addColorStop(0.55, storm > 0.5 ? "#1a2a2c" : "#162827");
      sky.addColorStop(1, "#12201d");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, this.width, this.height);

      const glow = ctx.createRadialGradient(
        this.width * 0.79, this.height * 0.16, 0,
        this.width * 0.79, this.height * 0.16, this.width * 0.3
      );
      glow.addColorStop(0, `rgba(224, 198, 121, ${0.06 - storm * 0.025})`);
      glow.addColorStop(1, "rgba(224, 198, 121, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, this.width, this.height * 0.64);

      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = "#b9cec1";
      ctx.lineWidth = 0.6;
      ctx.setLineDash([2, 8]);
      ctx.beginPath();
      ctx.moveTo(this.width * 0.74, 0);
      ctx.lineTo(this.width * 0.72, this.height * 0.55);
      ctx.stroke();
      ctx.restore();
    }

    drawRainHaze(ctx) {
      const rainAlpha = clamp(this.sim.env.rain / 65, 0.02, 0.22);
      const haze = ctx.createLinearGradient(0, this.height * 0.15, 0, this.height * 0.72);
      haze.addColorStop(0, `rgba(184, 207, 199, ${rainAlpha * 0.3})`);
      haze.addColorStop(1, `rgba(122, 164, 151, ${rainAlpha})`);
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, this.width, this.height * 0.78);
    }

    drawMountains(ctx) {
      const storm = clamp(this.sim.env.rain / 40, 0, 1);
      ctx.save();

      ctx.fillStyle = `rgba(18, 39, 34, ${0.62 + storm * 0.16})`;
      ctx.beginPath();
      ctx.moveTo(0, this.height * 0.54);
      ctx.lineTo(this.width * 0.11, this.height * 0.3);
      ctx.lineTo(this.width * 0.18, this.height * 0.4);
      ctx.lineTo(this.width * 0.32, this.height * 0.23);
      ctx.lineTo(this.width * 0.49, this.height * 0.47);
      ctx.lineTo(this.width * 0.64, this.height * 0.32);
      ctx.lineTo(this.width * 0.82, this.height * 0.49);
      ctx.lineTo(this.width, this.height * 0.35);
      ctx.lineTo(this.width, this.height * 0.62);
      ctx.lineTo(0, this.height * 0.62);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(27, 49, 42, 0.9)";
      ctx.beginPath();
      ctx.moveTo(0, this.height * 0.62);
      ctx.lineTo(this.width * 0.13, this.height * 0.46);
      ctx.lineTo(this.width * 0.27, this.height * 0.57);
      ctx.lineTo(this.width * 0.44, this.height * 0.4);
      ctx.lineTo(this.width * 0.59, this.height * 0.55);
      ctx.lineTo(this.width * 0.76, this.height * 0.42);
      ctx.lineTo(this.width, this.height * 0.56);
      ctx.lineTo(this.width, this.height * 0.72);
      ctx.lineTo(0, this.height * 0.72);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    drawSlope(ctx) {
      const sim = this.sim;
      const w = this.width;
      const h = this.height;
      const stress = clamp((0.82 - sim.trueState.stability) / 0.66, 0, 1);

      const surface = [
        [0, 0.59], [0.09, 0.36], [0.18, 0.25], [0.35, 0.18],
        [0.52, 0.25], [0.62, 0.42], [0.69, 0.67], [0.72, 0.82], [0, 0.86],
      ];

      ctx.save();
      ctx.beginPath();
      surface.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x * w, y * h);
        else ctx.lineTo(x * w, y * h);
      });
      ctx.closePath();
      const earth = ctx.createLinearGradient(w * 0.08, h * 0.2, w * 0.64, h * 0.8);
      earth.addColorStop(0, "#31473a");
      earth.addColorStop(0.35, "#2a3d32");
      earth.addColorStop(0.7, "#1b3028");
      earth.addColorStop(1, "#11251f");
      ctx.fillStyle = earth;
      ctx.fill();

      ctx.save();
      ctx.clip();
      this.drawStrata(ctx, stress);
      this.drawCracks(ctx, stress);
      this.drawSlopeVegetation(ctx);

      if (sim.roadBlocked) {
        const slide = ctx.createLinearGradient(w * 0.42, h * 0.35, w * 0.67, h * 0.8);
        slide.addColorStop(0, "rgba(86, 61, 39, 0.88)");
        slide.addColorStop(1, "rgba(55, 40, 29, 0.95)");
        ctx.fillStyle = slide;
        ctx.beginPath();
        ctx.moveTo(w * 0.42, h * 0.27);
        ctx.lineTo(w * 0.55, h * 0.37);
        ctx.lineTo(w * 0.7, h * 0.67);
        ctx.lineTo(w * 0.76, h * 0.82);
        ctx.lineTo(w * 0.54, h * 0.82);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      ctx.strokeStyle = "rgba(184, 222, 197, 0.22)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      surface.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x * w, y * h);
        else ctx.lineTo(x * w, y * h);
      });
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.fillStyle = "rgba(198, 224, 207, 0.44)";
      ctx.font = `600 ${Math.max(7, w * 0.0075)}px "Noto Sans SC", "SFMono-Regular", monospace`;
      ctx.letterSpacing = "1px";
      ctx.fillText("EAST SLOPE / K12+460", w * 0.055, h * 0.145);
      ctx.fillStyle = `rgba(244, 189, 85, ${0.35 + stress * 0.4})`;
      ctx.fillText("滑坡体 B2", w * 0.305, h * 0.39);
      ctx.restore();
    }

    drawStrata(ctx, stress) {
      const w = this.width;
      const h = this.height;
      const layers = [
        [[0, 0.28], [0.18, 0.26], [0.38, 0.21], [0.53, 0.31], [0.65, 0.63]],
        [[0, 0.43], [0.19, 0.37], [0.38, 0.34], [0.55, 0.43], [0.69, 0.7]],
        [[0, 0.6], [0.19, 0.52], [0.37, 0.53], [0.56, 0.59], [0.72, 0.78]],
      ];
      ctx.globalAlpha = 0.22;
      layers.forEach((layer, index) => {
        ctx.strokeStyle = index === 0 ? "#d2b56e" : "#91ad9d";
        ctx.lineWidth = index === 1 ? 1.2 : 0.7;
        ctx.beginPath();
        layer.forEach(([x, y], pointIndex) => {
          if (pointIndex === 0) ctx.moveTo(x * w, y * h);
          else {
            const prev = layer[pointIndex - 1];
            const midX = ((prev[0] + x) / 2) * w;
            const wobble = Math.sin(pointIndex * 4.1) * h * 0.008;
            ctx.quadraticCurveTo(midX, ((prev[1] + y) / 2) * h + wobble, x * w, y * h);
          }
        });
        ctx.stroke();
      });
      ctx.globalAlpha = 1;

      for (let i = 0; i < 17; i += 1) {
        const x = 0.07 + (i * 0.039) % 0.55;
        const y = 0.34 + ((i * 53) % 35) / 100;
        ctx.fillStyle = `rgba(9, 21, 17, ${0.12 + stress * 0.08})`;
        ctx.beginPath();
        ctx.ellipse(x * w, y * h, 3 + (i % 4), 1.5 + (i % 2), i * 0.7, 0, TAU);
        ctx.fill();
      }
    }

    drawCracks(ctx, stress) {
      const w = this.width;
      const h = this.height;
      const crackAlpha = 0.16 + stress * 0.7;
      ctx.strokeStyle = `rgba(235, 170, 74, ${crackAlpha})`;
      ctx.lineWidth = 0.7 + stress * 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(w * 0.25, h * 0.31);
      ctx.bezierCurveTo(w * 0.32, h * 0.4, w * 0.36, h * 0.44, w * 0.44, h * 0.53);
      ctx.bezierCurveTo(w * 0.51, h * 0.61, w * 0.55, h * 0.67, w * 0.58, h * 0.73);
      ctx.stroke();
      ctx.setLineDash([]);

      if (stress > 0.35) {
        ctx.strokeStyle = `rgba(255, 112, 76, ${(stress - 0.3) * 0.55})`;
        ctx.beginPath();
        ctx.moveTo(w * 0.42, h * 0.48);
        ctx.lineTo(w * 0.35, h * 0.58);
        ctx.moveTo(w * 0.47, h * 0.56);
        ctx.lineTo(w * 0.53, h * 0.65);
        ctx.moveTo(w * 0.31, h * 0.37);
        ctx.lineTo(w * 0.22, h * 0.45);
        ctx.stroke();
      }
    }

    drawSlopeVegetation(ctx) {
      const w = this.width;
      const h = this.height;
      const trees = [
        [0.09, 0.33, 10], [0.13, 0.29, 8], [0.18, 0.26, 11],
        [0.455, 0.225, 8], [0.49, 0.27, 8], [0.57, 0.31, 7],
      ];
      for (const [x, y, size] of trees) {
        const px = x * w;
        const py = y * h;
        ctx.strokeStyle = "rgba(5, 17, 13, 0.75)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(px, py + size * 0.2);
        ctx.lineTo(px, py - size * 0.7);
        ctx.stroke();
        ctx.fillStyle = "rgba(16, 46, 31, 0.88)";
        ctx.beginPath();
        ctx.moveTo(px, py - size * 1.5);
        ctx.lineTo(px - size * 0.55, py - size * 0.25);
        ctx.lineTo(px + size * 0.55, py - size * 0.25);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(111, 146, 104, 0.38)";
      ctx.lineWidth = 0.7;
      for (let i = 0; i < 30; i += 1) {
        const x = 0.06 + ((i * 29) % 52) / 100;
        const y = 0.32 + ((i * 17) % 32) / 100;
        ctx.beginPath();
        ctx.moveTo(x * w, y * h);
        ctx.lineTo((x + 0.006) * w, (y - 0.012) * h);
        ctx.stroke();
      }
    }

    drawRoad(ctx) {
      const w = this.width;
      const h = this.height;
      const points = ROAD_PATH.map((point) => [point.x * w, point.y * h]);
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.strokeStyle = "rgba(2, 8, 7, 0.7)";
      ctx.lineWidth = h * 0.112;
      this.strokePolyline(ctx, points);
      ctx.strokeStyle = "#283330";
      ctx.lineWidth = h * 0.098;
      this.strokePolyline(ctx, points);
      const asphalt = ctx.createLinearGradient(0, h * 0.65, 0, h * 0.86);
      asphalt.addColorStop(0, "#3c4844");
      asphalt.addColorStop(0.5, "#293531");
      asphalt.addColorStop(1, "#202c29");
      ctx.strokeStyle = asphalt;
      ctx.lineWidth = h * 0.083;
      this.strokePolyline(ctx, points);

      ctx.strokeStyle = "rgba(225, 236, 225, 0.3)";
      ctx.lineWidth = 1;
      this.offsetPolyline(ctx, points, -h * 0.041, 0.72);
      this.offsetPolyline(ctx, points, h * 0.041, 0.72);

      ctx.strokeStyle = "rgba(235, 228, 183, 0.52)";
      ctx.lineWidth = 1.15;
      ctx.setLineDash([h * 0.017, h * 0.021]);
      this.strokePolyline(ctx, points);
      ctx.setLineDash([]);

      if (this.sim.roadMode !== "OPEN") {
        this.drawBarrier(ctx, 0.095, this.sim.roadMode === "FULL_CLOSED");
        this.drawBarrier(ctx, 0.785, this.sim.roadMode === "FULL_CLOSED");
      }
      if (this.sim.roadBlocked) this.drawRoadDebris(ctx);
      ctx.restore();
    }

    strokePolyline(ctx, points) {
      ctx.beginPath();
      points.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    offsetPolyline(ctx, points, offset, alpha) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (let index = 0; index < points.length - 1; index += 1) {
        const [x1, y1] = points[index];
        const [x2, y2] = points[index + 1];
        const angle = Math.atan2(y2 - y1, x2 - x1) + Math.PI / 2;
        const ox = Math.cos(angle) * offset;
        const oy = Math.sin(angle) * offset;
        if (index === 0) ctx.moveTo(x1 + ox, y1 + oy);
        ctx.lineTo(x2 + ox, y2 + oy);
      }
      ctx.stroke();
      ctx.restore();
    }

    drawBarrier(ctx, progress, severe) {
      const point = pointOnPath(ROAD_PATH, progress);
      const w = this.width;
      const h = this.height;
      const px = point.x * w;
      const py = point.y * h;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(point.angle);
      ctx.fillStyle = severe ? "rgba(255, 93, 89, 0.78)" : "rgba(244, 189, 85, 0.75)";
      for (let i = -5; i <= 5; i += 1) {
        ctx.fillRect(i * h * 0.011, -h * 0.035, h * 0.005, h * 0.07);
      }
      ctx.fillStyle = "rgba(8, 17, 15, 0.86)";
      ctx.fillRect(-h * 0.059, -h * 0.009, h * 0.118, h * 0.018);
      ctx.restore();

      ctx.save();
      ctx.fillStyle = severe ? "#ff8b82" : "#f4bd55";
      ctx.beginPath();
      ctx.arc(px, py - h * 0.058, 2.3, 0, TAU);
      ctx.fill();
      if (Math.floor(this.sim.t * 4) % 2 === 0) {
        ctx.globalAlpha = 0.23;
        ctx.beginPath();
        ctx.arc(px, py - h * 0.058, 9, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    drawRoadDebris(ctx) {
      const w = this.width;
      const h = this.height;
      ctx.save();
      for (let i = 0; i < 31; i += 1) {
        const x = 0.43 + ((i * 37) % 29) / 100;
        const y = 0.7 + ((i * 23) % 15) / 100;
        const size = 2 + (i % 6);
        ctx.fillStyle = i % 4 === 0 ? "#60513c" : "#3a342b";
        ctx.beginPath();
        ctx.moveTo((x - 0.009) * w, (y + 0.004) * h);
        ctx.lineTo((x - 0.004) * w, (y - size * 0.006) * h);
        ctx.lineTo((x + 0.006) * w, (y - 0.002) * h);
        ctx.lineTo((x + 0.009) * w, (y + 0.007) * h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = "rgba(255, 93, 89, 0.12)";
      ctx.fillRect(w * 0.29, h * 0.65, w * 0.52, h * 0.2);
      ctx.restore();
    }

    drawVehicles(ctx) {
      const sim = this.sim;
      const w = this.width;
      const h = this.height;

      if (sim.roadMode === "OPEN" && !sim.roadBlocked) {
        for (let index = 0; index < 4; index += 1) {
          const raw = ((sim.t / 176 + index * 0.265) % 1.16) - 0.08;
          if (raw < 0 || raw > 1) continue;
          const point = pointOnPath(ROAD_PATH, raw);
          this.drawCar(ctx, point.x * w, point.y * h, point.angle, index % 2 ? "#c6d0c5" : "#9bb3a8", false);
        }
      } else if (sim.roadMode === "CONTROLLED" && !sim.roadBlocked) {
        for (let index = 0; index < 3; index += 1) {
          const point = pointOnPath(ROAD_PATH, 0.055 + index * 0.038);
          this.drawCar(ctx, point.x * w, point.y * h, point.angle, index % 2 ? "#b2bcb1" : "#879a91", false);
        }
      }

      for (const rescue of sim.rescueLog) {
        const local = sim.t - rescue.time;
        if (local < -38 || local > 38 || sim.roadBlocked) continue;
        const progress = clamp((local + 38) / 76, 0, 1);
        const point = pointOnPath(ROAD_PATH, 0.1 + progress * 0.8);
        this.drawCar(ctx, point.x * w, point.y * h, point.angle, "#e5ebe3", true, Math.floor(sim.t * 7) % 2);
      }
    }

    drawCar(ctx, x, y, angle, color, rescue, flash) {
      const h = this.height;
      const length = Math.max(12, h * 0.038);
      const width = length * 0.46;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = "rgba(0, 0, 0, 0.33)";
      ctx.beginPath();
      ctx.roundRect(-length / 2 + 2, -width / 2 + 3, length, width, 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(-length / 2, -width / 2, length, width, 2);
      ctx.fill();
      ctx.fillStyle = rescue ? "rgba(106, 168, 255, 0.9)" : "rgba(31, 50, 45, 0.72)";
      ctx.fillRect(-length * 0.13, -width * 0.37, length * 0.32, width * 0.74);
      ctx.fillStyle = "rgba(255, 236, 172, 0.92)";
      ctx.fillRect(length * 0.42, -width * 0.35, 1.6, 2);
      ctx.fillRect(length * 0.42, width * 0.2, 1.6, 2);
      if (rescue) {
        ctx.fillStyle = flash ? "#ff5d59" : "#6aa8ff";
        ctx.fillRect(-length * 0.08, -width * 0.53, length * 0.16, 2);
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.arc(0, 0, length * 0.92, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }

    drawAnchorsAndSensors(ctx) {
      const sim = this.sim;
      const w = this.width;
      const h = this.height;
      const pulse = 0.5 + Math.sin(this.frameTime * 0.004) * 0.5;

      for (const anchor of ANCHORS) {
        const px = anchor.x * w;
        const py = anchor.y * h;
        const sensor = sim.sensors.find((item) => item.anchorId === anchor.id);
        const hovered = this.hoveredAnchor?.id === anchor.id;
        const available = this.activeSensorType && !sensor;

        ctx.save();
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = available
          ? `rgba(184, 242, 108, ${0.24 + pulse * 0.3})`
          : hovered
            ? "rgba(237, 244, 238, 0.65)"
            : "rgba(192, 218, 203, 0.16)";
        ctx.lineWidth = available ? 1.2 : 0.8;
        ctx.beginPath();
        ctx.arc(px, py, available ? 10 + pulse * 4 : 8, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = available
          ? rgba("#b8f26c", 0.2 + pulse * 0.12)
          : hovered ? "rgba(237, 244, 238, 0.16)" : "rgba(8, 20, 17, 0.45)";
        ctx.beginPath();
        ctx.arc(px, py, 4.2, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = available ? "rgba(184, 242, 108, 0.8)" : "rgba(194, 218, 204, 0.4)";
        ctx.stroke();

        ctx.fillStyle = "rgba(217, 232, 221, 0.55)";
        ctx.font = `600 ${Math.max(7, w * 0.0066)}px "Noto Sans SC", "SFMono-Regular", monospace`;
        ctx.fillText(anchor.id, px + 10, py - 8);

        if (sensor) this.drawSensor(ctx, sensor, px, py);
        ctx.restore();
      }
    }

    drawSensor(ctx, sensor, x, y) {
      const h = this.height;
      const spec = SENSOR_TYPES[sensor.type];
      const fault = sensor.status === "offline" || sensor.status === "outlier";
      const color = fault
        ? (sensor.status === "offline" ? "#ff5d59" : "#f4bd55")
        : spec.color;
      const lowQuality = sensor.quality < 0.58;

      ctx.save();
      ctx.strokeStyle = rgba(color, 0.72);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y + 2);
      ctx.lineTo(x, y - h * 0.05);
      ctx.stroke();

      ctx.fillStyle = "#101d1a";
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.roundRect(x - 5, y - h * 0.067, 10, 12, 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = rgba(color, 0.72);
      ctx.fillRect(x - 3, y - h * 0.061, 6, 2);

      if (sensor.status === "online") {
        const wave = 0.35 + (Math.sin(this.frameTime * 0.004 + x) + 1) * 0.18;
        ctx.strokeStyle = rgba(color, wave);
        ctx.beginPath();
        ctx.arc(x, y - h * 0.061, 8, -2.4, -0.74);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y - h * 0.061, 12, -2.4, -0.74);
        ctx.stroke();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x + 7, y - h * 0.075);
        ctx.lineTo(x + 13, y - h * 0.069);
        ctx.moveTo(x + 13, y - h * 0.075);
        ctx.lineTo(x + 7, y - h * 0.069);
        ctx.stroke();
      }

      if (lowQuality && sensor.status === "online") {
        ctx.strokeStyle = "rgba(244, 189, 85, 0.7)";
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(x, y - h * 0.06, 15, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const reading = sensor.status === "outlier"
        ? "越限"
        : sensor.status === "offline"
          ? "离线"
          : sensor.reading == null
            ? "--"
            : `${round(sensor.reading, spec.decimals)}`;
      ctx.font = `500 ${Math.max(7, this.width * 0.006)}px "Noto Sans SC", "SFMono-Regular", monospace`;
      const text = `${spec.short} ${reading}${sensor.status === "online" ? spec.unit : ""}`;
      const textWidth = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(7, 18, 15, 0.78)";
      ctx.beginPath();
      ctx.roundRect(x + 14, y - h * 0.083, textWidth + 9, 14, 3);
      ctx.fill();
      ctx.fillStyle = rgba(color, 0.9);
      ctx.fillText(text, x + 18.5, y - h * 0.083 + 9.5);
      ctx.restore();
    }

    drawRain(ctx) {
      const sim = this.sim;
      const intensity = clamp(sim.env.rain / 38, 0, 1);
      const count = Math.round(12 + intensity * 150);
      const w = this.width;
      const h = this.height;
      const time = sim.t;
      ctx.save();
      ctx.lineCap = "round";
      for (let index = 0; index < count; index += 1) {
        const seedX = ((index * 73 + 19) % 997) / 997;
        const speed = 0.22 + (index % 9) * 0.018;
        const y = ((time * speed + (index * 31) / count) % 1) * h * 1.05;
        const x = (seedX * w + Math.sin(time * 0.012 + index) * w * 0.012) % w;
        const length = 5 + (index % 7) * 1.5 + intensity * 6;
        ctx.strokeStyle = `rgba(166, 198, 201, ${0.08 + intensity * 0.24})`;
        ctx.lineWidth = index % 7 === 0 ? 1 : 0.55;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - length * 0.18, y + length);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawAtmosphere(ctx) {
      const sim = this.sim;
      const w = this.width;
      const h = this.height;
      const vignette = ctx.createRadialGradient(w * 0.52, h * 0.46, h * 0.15, w * 0.52, h * 0.46, w * 0.72);
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(1, "rgba(0, 5, 4, 0.48)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, w, h);

      if (sim.alertLevel >= 2 && !sim.failed) {
        const alpha = (sim.alertLevel === 3 ? 0.13 : 0.07) * (0.72 + Math.sin(this.frameTime * 0.006) * 0.28);
        ctx.strokeStyle = `rgba(255, ${sim.alertLevel === 3 ? 93 : 138}, ${sim.alertLevel === 3 ? 89 : 76}, ${alpha + 0.06})`;
        ctx.lineWidth = sim.alertLevel === 3 ? 2 : 1;
        ctx.strokeRect(2, 2, w - 4, h - 4);
      }
      if (sim.failed) {
        ctx.fillStyle = "rgba(93, 16, 13, 0.12)";
        ctx.fillRect(0, 0, w, h);
      }

      ctx.save();
      ctx.strokeStyle = "rgba(184, 242, 108, 0.22)";
      ctx.lineWidth = 0.7;
      const scanX = (sim.t * 0.012) % (w * 0.7) + w * 0.06;
      const scan = ctx.createLinearGradient(scanX - 8, 0, scanX + 8, 0);
      scan.addColorStop(0, "rgba(184, 242, 108, 0)");
      scan.addColorStop(0.5, "rgba(184, 242, 108, 0.18)");
      scan.addColorStop(1, "rgba(184, 242, 108, 0)");
      ctx.fillStyle = scan;
      ctx.fillRect(scanX - 8, 0, 16, h * 0.83);
      ctx.restore();
    }
  }

  class AlertAudio {
    constructor(enabled = true) {
      this.enabled = enabled;
      this.context = null;
      this.lastLevel = 0;
      this.lastPatternAt = -Infinity;
      this.master = null;
    }

    unlock() {
      if (!this.enabled) return;
      if (!this.context) {
        const AudioContext = root.AudioContext || root.webkitAudioContext;
        if (!AudioContext) return;
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = 0.22;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === "suspended") this.context.resume().catch(() => {});
    }

    setEnabled(enabled) {
      this.enabled = enabled;
      if (enabled) this.unlock();
      if (this.master) this.master.gain.value = enabled ? 0.22 : 0;
    }

    tone(frequency, start, duration, gain = 0.22, type = "sine") {
      const ctx = this.context;
      const oscillator = ctx.createOscillator();
      const envelope = ctx.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      envelope.gain.setValueAtTime(0.0001, start);
      envelope.gain.exponentialRampToValueAtTime(gain, start + 0.025);
      envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(envelope);
      envelope.connect(this.master);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.04);
    }

    pattern(level) {
      if (!this.enabled) return;
      this.unlock();
      if (!this.context) return;
      const now = this.context.currentTime + 0.02;
      if (level === 1) {
        this.tone(430, now, 0.16, 0.14);
      } else if (level === 2) {
        this.tone(620, now, 0.13, 0.19, "triangle");
        this.tone(620, now + 0.2, 0.13, 0.19, "triangle");
      } else if (level === 3) {
        this.tone(820, now, 0.12, 0.23, "square");
        this.tone(660, now + 0.16, 0.12, 0.23, "square");
        this.tone(820, now + 0.32, 0.12, 0.23, "square");
      } else if (level === -1) {
        this.tone(180, now, 0.65, 0.2, "sawtooth");
      }
    }

    update(level, isRunning, nowMs) {
      if (!this.enabled) return;
      if (level !== this.lastLevel) {
        this.lastLevel = level;
        if (level > 0) {
          this.pattern(level);
          this.lastPatternAt = nowMs;
        }
        return;
      }
      if (!isRunning || level <= 0) return;
      const interval = level === 3 ? 1150 : level === 2 ? 1900 : 3400;
      if (nowMs - this.lastPatternAt > interval) {
        this.pattern(level);
        this.lastPatternAt = nowMs;
      }
    }

    failure() {
      this.pattern(-1);
    }
  }

  root.LandslideRender = { SceneRenderer, AlertAudio, ROAD_PATH };
})(window);
