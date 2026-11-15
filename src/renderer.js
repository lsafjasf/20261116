const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function hash(index) {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  draw(view, realTime = 0) {
    if (!view) return;
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    this._drawSky(view, w, h, realTime);
    this._drawSea(view, w, h);
    this._drawDistantFarm(view, w, h);
    this._drawWind(view, w, h);
    this._drawTurbine(view, w, h);
    this._drawAtmosphere(view, w, h, realTime);
    this._drawScanlines(w, h);
  }

  _drawSky(view, w, h, realTime) {
    const ctx = this.ctx;
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.78);
    sky.addColorStop(0, "#06151d");
    sky.addColorStop(0.38, "#0b2630");
    sky.addColorStop(0.72, "#123840");
    sky.addColorStop(1, "#2b4a48");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const glowX = w * 0.74;
    const glowY = h * 0.54;
    const glow = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, w * 0.48);
    glow.addColorStop(0, "rgba(226, 160, 89, 0.21)");
    glow.addColorStop(0.25, "rgba(158, 119, 80, 0.09)");
    glow.addColorStop(1, "rgba(8, 18, 23, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalAlpha = 0.36;
    for (let i = 0; i < 32; i += 1) {
      const x = hash(i * 2.7) * w;
      const y = hash(i * 5.1 + 2) * h * 0.42;
      const size = hash(i + 8) > 0.84 ? 1.3 : 0.7;
      ctx.fillStyle = i % 7 === 0 ? "#b7e6e2" : "#7f9da2";
      ctx.fillRect(x, y, size, size);
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "rgba(150, 207, 207, 0.38)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w * 0.08, h * 0.16);
    ctx.lineTo(w * 0.92, h * 0.13);
    ctx.moveTo(w * 0.3, h * 0.31);
    ctx.lineTo(w * 0.95, h * 0.28);
    ctx.stroke();
    ctx.restore();

    if (view.fault) {
      const alpha = 0.025 + Math.sin(realTime * 0.003) * 0.008;
      ctx.fillStyle = `rgba(255, 80, 70, ${alpha})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  _drawSea(view, w, h) {
    const ctx = this.ctx;
    const horizon = h * 0.72;
    const sea = ctx.createLinearGradient(0, horizon, 0, h);
    sea.addColorStop(0, "#17343b");
    sea.addColorStop(0.25, "#0d252e");
    sea.addColorStop(1, "#041117");
    ctx.fillStyle = sea;
    ctx.fillRect(0, horizon, w, h - horizon);

    const light = ctx.createLinearGradient(0, horizon, 0, h);
    light.addColorStop(0, "rgba(220, 168, 104, 0.1)");
    light.addColorStop(0.34, "rgba(105, 169, 166, 0.04)");
    light.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = light;
    ctx.fillRect(w * 0.55, horizon, w * 0.4, h - horizon);

    ctx.save();
    ctx.strokeStyle = "rgba(130, 193, 193, 0.12)";
    ctx.lineWidth = 0.8;
    for (let row = 0; row < 16; row += 1) {
      const y = horizon + row * 7 + 4;
      const amplitude = 1.2 + row * 0.16;
      const speed = view.t * (1.1 + row * 0.03);
      ctx.beginPath();
      for (let x = -20; x <= w + 20; x += 18) {
        const wave = Math.sin(x * 0.018 + speed + row * 0.8) * amplitude;
        if (x === -20) ctx.moveTo(x, y + wave);
        else ctx.lineTo(x, y + wave);
      }
      ctx.globalAlpha = 0.16 + row * 0.012;
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = "rgba(196, 222, 214, 0.07)";
    ctx.fillRect(0, horizon - 1, w, 1);
  }

  _drawDistantFarm(view, w, h) {
    const ctx = this.ctx;
    const horizon = h * 0.72;
    const positions = [
      [0.07, 0.12, 0.34],
      [0.17, 0.08, 0.25],
      [0.89, 0.1, 0.3],
      [0.97, 0.065, 0.23],
    ];
    ctx.save();
    ctx.strokeStyle = "rgba(136, 181, 182, 0.22)";
    ctx.fillStyle = "rgba(136, 181, 182, 0.22)";
    ctx.lineWidth = 1;
    for (const [xRatio, size, alpha] of positions) {
      const x = xRatio * w;
      const top = horizon - size * h;
      const radius = size * h * 0.3;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(x - 1, horizon);
      ctx.lineTo(x - 0.4, top);
      ctx.lineTo(x + 0.4, top);
      ctx.lineTo(x + 1, horizon);
      ctx.fill();
      for (let i = 0; i < 3; i += 1) {
        const angle = view.t * 0.025 + i * (TAU / 3);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x + Math.cos(angle) * radius, top + Math.sin(angle) * radius);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _drawWind(view, w, h) {
    const ctx = this.ctx;
    const wind = view.env.wind;
    const speed = 16 + wind * 5.2;
    const count = clamp(Math.round(12 + wind * 1.8), 14, 55);
    const gust = clamp(view.env.gust / 8, 0, 1);

    ctx.save();
    ctx.lineCap = "round";
    for (let i = 0; i < count; i += 1) {
      const baseY = h * (0.08 + hash(i * 2.3) * 0.62);
      const length = 18 + hash(i * 4.1) * 68 + wind * 2.2;
      const offset = hash(i * 7.7) * (w + 160);
      const x = ((offset + view.t * speed * (0.55 + hash(i + 3) * 0.8)) % (w + 190)) - 95;
      const y = baseY + Math.sin(view.t * 0.8 + i) * 2.5;
      const slope = 1.5 + hash(i + 9) * 3.5;
      const alpha = 0.05 + hash(i + 4) * 0.12 + gust * 0.09;
      ctx.strokeStyle = gust > 0.25 ? `rgba(219, 183, 136, ${alpha})` : `rgba(154, 216, 215, ${alpha})`;
      ctx.lineWidth = 0.6 + hash(i + 8) * 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + length, y + slope);
      ctx.stroke();
      if (i % 5 === 0) {
        ctx.fillStyle = `rgba(180, 222, 220, ${alpha * 0.7})`;
        ctx.fillRect(x + length + 6, y + slope, 2, 2);
      }
    }
    ctx.restore();
  }

  _drawTurbine(view, w, h) {
    const hub = {
      x: w * 0.36,
      y: h * 0.42,
    };
    const radius = Math.min(h * 0.35, w * 0.205);
    const horizon = h * 0.72;
    const ctx = this.ctx;
    const rotorAngle = -view.mission.bladeIndex * (TAU / 3);
    const swayPx = view.platform.sway * 42;

    this._drawTower(ctx, hub, horizon, w, h);
    this._drawNacelle(ctx, hub, w, h);

    for (let i = 0; i < 3; i += 1) {
      const blade = view.blades[i];
      this._drawBlade(ctx, hub, radius, rotorAngle + i * (TAU / 3), blade, i, view, w, h);
    }

    this._drawHub(ctx, hub);

    const activeBlade = view.blades[view.mission.bladeIndex] || view.blades[0];
    const activeAngle = rotorAngle + view.mission.bladeIndex * (TAU / 3);
    this._drawPlatform(ctx, hub, radius, activeAngle, activeBlade, view, swayPx);
    this._drawPlatformLabel(ctx, hub, radius, activeAngle, activeBlade, view, swayPx);
  }

  _drawTower(ctx, hub, horizon, w, h) {
    const baseX = hub.x + 2;
    const towerTop = hub.y + 14;
    const gradient = ctx.createLinearGradient(baseX - 24, 0, baseX + 26, 0);
    gradient.addColorStop(0, "rgba(111, 145, 146, 0.14)");
    gradient.addColorStop(0.45, "rgba(204, 222, 216, 0.52)");
    gradient.addColorStop(0.6, "rgba(129, 161, 160, 0.38)");
    gradient.addColorStop(1, "rgba(44, 70, 73, 0.35)");
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(baseX - 11, towerTop);
    ctx.lineTo(baseX + 11, towerTop);
    ctx.lineTo(baseX + 24, horizon + 4);
    ctx.lineTo(baseX - 24, horizon + 4);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(163, 204, 201, 0.16)";
    ctx.lineWidth = 1;
    for (let y = towerTop + 18; y < horizon; y += 34) {
      const ratio = (y - towerTop) / (horizon - towerTop);
      const half = 11 + ratio * 13;
      ctx.beginPath();
      ctx.moveTo(baseX - half, y);
      ctx.lineTo(baseX + half, y);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(4, 15, 19, 0.88)";
    ctx.fillRect(baseX - 31, horizon - 1, 62, 8);
    ctx.fillStyle = "rgba(255, 184, 77, 0.62)";
    ctx.fillRect(baseX - 19, towerTop + 43, 2, 2);
    ctx.fillRect(baseX + 16, towerTop + 76, 2, 2);
    ctx.restore();
  }

  _drawNacelle(ctx, hub, w, h) {
    ctx.save();
    const nacelle = ctx.createLinearGradient(hub.x - 76, hub.y - 20, hub.x + 38, hub.y + 19);
    nacelle.addColorStop(0, "rgba(86, 115, 116, 0.34)");
    nacelle.addColorStop(0.6, "rgba(214, 227, 219, 0.56)");
    nacelle.addColorStop(1, "rgba(98, 129, 130, 0.35)");
    ctx.fillStyle = nacelle;
    ctx.beginPath();
    ctx.moveTo(hub.x - 70, hub.y - 17);
    ctx.lineTo(hub.x + 19, hub.y - 22);
    ctx.quadraticCurveTo(hub.x + 43, hub.y - 20, hub.x + 45, hub.y);
    ctx.quadraticCurveTo(hub.x + 41, hub.y + 19, hub.x + 17, hub.y + 21);
    ctx.lineTo(hub.x - 71, hub.y + 14);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(207, 231, 226, 0.2)";
    ctx.stroke();

    ctx.fillStyle = "rgba(7, 23, 28, 0.7)";
    ctx.fillRect(hub.x - 47, hub.y - 9, 13, 5);
    ctx.fillStyle = "rgba(255, 184, 77, 0.8)";
    ctx.fillRect(hub.x - 64, hub.y + 4, 2, 2);
    ctx.restore();
  }

  _drawBlade(ctx, hub, radius, angle, blade, bladeIndex, view, w, h) {
    const length = radius * 0.93;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const normalX = -sin;
    const normalY = cos;
    const baseWidth = radius * 0.112;
    const tipWidth = radius * 0.038;

    ctx.save();
    ctx.translate(hub.x, hub.y);
    ctx.rotate(angle);
    const bladeGradient = ctx.createLinearGradient(0, -baseWidth, 0, baseWidth);
    bladeGradient.addColorStop(0, "rgba(154, 178, 174, 0.36)");
    bladeGradient.addColorStop(0.35, "rgba(237, 241, 229, 0.85)");
    bladeGradient.addColorStop(0.62, "rgba(198, 214, 206, 0.68)");
    bladeGradient.addColorStop(1, "rgba(76, 103, 104, 0.53)");
    ctx.fillStyle = bladeGradient;
    ctx.beginPath();
    ctx.moveTo(radius * 0.075, -baseWidth * 0.63);
    ctx.quadraticCurveTo(length * 0.47, -baseWidth * 0.68, length * 0.96, -tipWidth);
    ctx.quadraticCurveTo(length * 1.012, 0, length * 0.96, tipWidth * 0.8);
    ctx.quadraticCurveTo(length * 0.5, baseWidth * 0.57, radius * 0.075, baseWidth * 0.63);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(223, 238, 231, 0.2)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = "rgba(77, 108, 107, 0.28)";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(length * 0.12, 0);
    ctx.lineTo(length * 0.89, 0);
    ctx.stroke();

    const damageStart = length * (0.44 + bladeIndex * 0.03);
    const damageSpan = length * (0.11 + blade.damage * 0.14);
    ctx.globalAlpha = blade.repaired ? 0.42 : 0.86;
    ctx.fillStyle = blade.repaired ? "#73dca0" : "#b6905f";
    ctx.beginPath();
    ctx.ellipse(
      damageStart + damageSpan * 0.5,
      baseWidth * 0.08,
      damageSpan * 0.54,
      baseWidth * 0.24,
      -0.08,
      0,
      TAU,
    );
    ctx.fill();
    ctx.globalAlpha = 1;

    if (!blade.repaired) {
      ctx.strokeStyle = "rgba(255, 184, 77, 0.72)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(damageStart, -baseWidth * 0.08);
      ctx.lineTo(damageStart + damageSpan, baseWidth * 0.2);
      ctx.moveTo(damageStart + damageSpan * 0.72, -baseWidth * 0.16);
      ctx.lineTo(damageStart + damageSpan * 0.42, baseWidth * 0.22);
      ctx.stroke();
    }

    if (blade.active) {
      this._drawBladeOperation(ctx, length, baseWidth, blade, view);
    }
    ctx.restore();

    if (!blade.repaired && blade.active) {
      const labelDistance = length * 0.73;
      const labelX = hub.x + cos * labelDistance + normalX * baseWidth * 1.8;
      const labelY = hub.y + sin * labelDistance + normalY * baseWidth * 1.8;
      this._drawBladeTag(ctx, labelX, labelY, blade, view);
    }
  }

  _drawBladeOperation(ctx, length, baseWidth, blade, view) {
    const stage = view.mission.stage;
    const progress = view.mission.stageProgress;
    const center = length * 0.68;
    if (stage === "sand") {
      const glow = ctx.createRadialGradient(center, 0, 0, center, 0, baseWidth * 1.7);
      glow.addColorStop(0, "rgba(255, 204, 139, 0.62)");
      glow.addColorStop(1, "rgba(255, 184, 77, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(center, 0, baseWidth * 1.7, 0, TAU);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 226, 164, 0.9)";
      for (let i = 0; i < 8; i += 1) {
        const angle = hash(i + view.tick) * TAU;
        const distance = 5 + hash(i * 3 + 2) * 19;
        ctx.fillRect(center + Math.cos(angle) * distance, Math.sin(angle) * distance, 1.2, 1.2);
      }
    } else if (stage === "coat") {
      ctx.fillStyle = "rgba(107, 226, 220, 0.28)";
      ctx.beginPath();
      ctx.roundRect(center - length * 0.12, -baseWidth * 0.38, length * 0.24 * progress, baseWidth * 0.76, 6);
      ctx.fill();
      ctx.strokeStyle = "rgba(132, 244, 239, 0.66)";
      ctx.stroke();
      for (let i = 0; i < 5; i += 1) {
        const a = view.t * 3 + i;
        ctx.fillStyle = `rgba(150, 236, 233, ${0.2 + hash(i) * 0.3})`;
        ctx.beginPath();
        ctx.arc(center + 11 + Math.cos(a) * 8, Math.sin(a) * 10, 2.2, 0, TAU);
        ctx.fill();
      }
    } else if (stage === "dry") {
      ctx.strokeStyle = `rgba(124, 230, 164, ${0.28 + progress * 0.34})`;
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.ellipse(center, 0, 15 + i * 9 + progress * 9, 5 + i * 2, 0, 0, TAU);
        ctx.stroke();
      }
    } else if (stage === "light") {
      ctx.fillStyle = "rgba(124, 230, 164, 0.16)";
      ctx.beginPath();
      ctx.moveTo(center, -baseWidth * 0.9);
      ctx.lineTo(length * 1.09, -baseWidth * 2.8);
      ctx.lineTo(length * 1.09, baseWidth * 2.8);
      ctx.lineTo(center, baseWidth * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#b5ffd1";
      ctx.beginPath();
      ctx.arc(center, 0, 3, 0, TAU);
      ctx.fill();
    }
  }

  _drawBladeTag(ctx, x, y, blade, view) {
    const active = view.mission.stage;
    const color = active === "sand" ? "#ffcf85" : active === "coat" ? "#9df4ef" : "#a5edc0";
    ctx.save();
    ctx.fillStyle = "rgba(5, 18, 22, 0.84)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.7;
    ctx.fillRect(x - 16, y - 10, 55, 19);
    ctx.strokeRect(x - 16, y - 10, 55, 19);
    ctx.fillStyle = color;
    ctx.font = '8px "IBM Plex Mono", Consolas, monospace';
    ctx.fillText(`${blade.label} · ${Math.round(blade.progress * 100)}%`, x - 11, y + 3);
    ctx.restore();
  }

  _drawHub(ctx, hub) {
    const gradient = ctx.createRadialGradient(hub.x - 8, hub.y - 10, 2, hub.x, hub.y, 27);
    gradient.addColorStop(0, "#dfe9df");
    gradient.addColorStop(0.35, "#a8bab4");
    gradient.addColorStop(0.72, "#627b7b");
    gradient.addColorStop(1, "#263e43");
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(hub.x, hub.y, 25, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(230, 244, 237, 0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "rgba(8, 26, 31, 0.8)";
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * TAU;
      ctx.beginPath();
      ctx.arc(hub.x + Math.cos(angle) * 16, hub.y + Math.sin(angle) * 16, 2, 0, TAU);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(hub.x, hub.y, 6, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  _drawPlatform(ctx, hub, radius, angle, blade, view, swayPx) {
    const anchorDistance = radius * 0.72;
    const anchorX = hub.x + Math.cos(angle) * anchorDistance + swayPx;
    const anchorY = hub.y + Math.sin(angle) * anchorDistance;
    const gapPx = view.platform.gap * 58;
    const deckY = anchorY + 33 + gapPx;
    const deckW = 86;
    const deckH = 17;
    const mode = view.platform.mode;
    const alert = mode === "retract" || mode === "hold" || view.currentFaultId;

    ctx.save();
    ctx.strokeStyle = "rgba(180, 204, 195, 0.48)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(anchorX - 31, anchorY + 2);
    ctx.lineTo(anchorX - 31, deckY - 3);
    ctx.moveTo(anchorX + 31, anchorY + 2);
    ctx.lineTo(anchorX + 31, deckY - 3);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(4, 13, 16, 0.68)";
    ctx.fillRect(anchorX - 38, anchorY - 5, 76, 9);
    ctx.strokeStyle = "rgba(195, 211, 200, 0.28)";
    ctx.strokeRect(anchorX - 38, anchorY - 5, 76, 9);

    const deckGradient = ctx.createLinearGradient(anchorX, deckY, anchorX, deckY + deckH);
    deckGradient.addColorStop(0, alert ? "#b57045" : "#a88d4e");
    deckGradient.addColorStop(0.2, alert ? "#8a4e37" : "#836d3a");
    deckGradient.addColorStop(1, "#343c38");
    ctx.fillStyle = deckGradient;
    ctx.fillRect(anchorX - deckW / 2, deckY, deckW, deckH);
    ctx.strokeStyle = alert ? "rgba(255, 132, 105, 0.72)" : "rgba(255, 204, 108, 0.6)";
    ctx.strokeRect(anchorX - deckW / 2, deckY, deckW, deckH);

    ctx.fillStyle = "rgba(8, 20, 22, 0.92)";
    ctx.fillRect(anchorX - deckW / 2 + 5, deckY + deckH, 7, 24);
    ctx.fillRect(anchorX + deckW / 2 - 12, deckY + deckH, 7, 24);
    ctx.strokeStyle = "rgba(191, 215, 207, 0.25)";
    ctx.beginPath();
    ctx.moveTo(anchorX - deckW / 2 + 10, deckY + deckH);
    ctx.lineTo(anchorX - deckW / 2 + 10, deckY);
    ctx.moveTo(anchorX + deckW / 2 - 10, deckY + deckH);
    ctx.lineTo(anchorX + deckW / 2 - 10, deckY);
    ctx.stroke();

    const blink = Math.sin(view.t * 9) > 0;
    ctx.fillStyle = alert ? (blink ? "#ff655f" : "#632d2c") : blink ? "#ffb84d" : "#684d2c";
    ctx.beginPath();
    ctx.arc(anchorX + deckW / 2 - 7, deckY + 4, 2.2, 0, TAU);
    ctx.fill();

    this._drawWorker(ctx, anchorX - 18, deckY - 2, view, 0);
    this._drawWorker(ctx, anchorX + 10, deckY - 2, view, 1);

    if (mode === "contact" || mode === "hold" || mode === "retract") {
      this._drawToolArm(ctx, anchorX + 22, deckY, anchorY, blade, view);
    }

    if (alert) {
      ctx.strokeStyle = `rgba(255, 101, 95, ${0.25 + Math.abs(Math.sin(view.t * 2.4)) * 0.25})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(anchorX, deckY + 8, 54, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawWorker(ctx, x, y, view, variant) {
    ctx.save();
    ctx.fillStyle = variant ? "#d6b761" : "#ccba71";
    ctx.fillRect(x - 2.5, y - 12, 5, 12);
    ctx.fillStyle = "#e7d9a5";
    ctx.beginPath();
    ctx.arc(x, y - 15, 3, 0, TAU);
    ctx.fill();
    ctx.fillStyle = variant ? "#ffe071" : "#f5cc57";
    ctx.beginPath();
    ctx.arc(x, y - 16.5, 3.4, Math.PI, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(205, 228, 216, 0.5)";
    ctx.lineWidth = 0.7;
    const reach = Math.sin(view.t * 3 + variant) * 2;
    ctx.beginPath();
    ctx.moveTo(x + 2, y - 10);
    ctx.lineTo(x + 8 + reach, y - 6);
    ctx.stroke();
    ctx.restore();
  }

  _drawToolArm(ctx, x, deckY, anchorY, blade, view) {
    const stage = view.mission.stage;
    const toolY = anchorY + 8;
    ctx.save();
    ctx.strokeStyle = stage === "sand" ? "rgba(255, 200, 128, 0.78)" : "rgba(151, 203, 199, 0.62)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, deckY);
    ctx.lineTo(x + 3, toolY);
    ctx.stroke();
    ctx.fillStyle = stage === "sand" ? "#c98d4e" : "#5d9292";
    ctx.fillRect(x - 4, toolY - 2, 11, 5);
    if (stage === "sand") {
      for (let i = 0; i < 7; i += 1) {
        const phase = view.t * 4 + i * 1.7;
        ctx.fillStyle = i % 2 ? "rgba(255, 220, 150, 0.9)" : "rgba(255, 176, 91, 0.8)";
        ctx.fillRect(x + 6 + Math.cos(phase) * (4 + i), toolY - 3 + Math.sin(phase) * (2 + i * 0.6), 1.5, 1.5);
      }
    }
    ctx.restore();
  }

  _drawPlatformLabel(ctx, hub, radius, angle, blade, view, swayPx) {
    const anchorDistance = radius * 0.72;
    const anchorX = hub.x + Math.cos(angle) * anchorDistance + swayPx;
    const anchorY = hub.y + Math.sin(angle) * anchorDistance;
    const deckY = anchorY + 33 + view.platform.gap * 58;
    ctx.save();
    ctx.font = '7px "IBM Plex Mono", Consolas, monospace';
    ctx.fillStyle = "rgba(178, 206, 200, 0.6)";
    const gapLabel = view.platform.gap > 0.16 ? `GAP ${view.platform.gap.toFixed(2)}m` : "TOOL CONTACT";
    ctx.fillText(`PLATFORM / ${gapLabel}`, anchorX - 43, deckY + 40);
    ctx.fillStyle = view.currentFaultId ? "#ff8c86" : "#76e5df";
    ctx.fillText(`SWAY ${view.platform.sway.toFixed(2)}m`, anchorX - 43, deckY + 49);
    ctx.restore();
  }

  _drawAtmosphere(view, w, h, realTime) {
    const ctx = this.ctx;
    const cone = ctx.createRadialGradient(w * 0.39, h * 0.42, 10, w * 0.39, h * 0.42, h * 0.52);
    cone.addColorStop(0, "rgba(3, 11, 14, 0)");
    cone.addColorStop(0.7, "rgba(3, 11, 14, 0.04)");
    cone.addColorStop(1, "rgba(3, 11, 14, 0.52)");
    ctx.fillStyle = cone;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = "rgba(197, 230, 222, 0.06)";
    ctx.fillRect(w * 0.02, h * 0.08, 1, h * 0.23);
    ctx.fillRect(w * 0.02, h * 0.08, 16, 1);

    if (view.currentFaultId) {
      const alpha = 0.08 + Math.abs(Math.sin(realTime * 0.006)) * 0.05;
      ctx.strokeStyle = `rgba(255, 101, 95, ${alpha})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(5.5, 5.5, w - 11, h - 11);
    }
  }

  _drawScanlines(w, h) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.035;
    ctx.fillStyle = "#9de4dd";
    for (let y = 0; y < h; y += 4) {
      ctx.fillRect(0, y, w, 1);
    }
    ctx.restore();
  }
}
