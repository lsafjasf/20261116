import { CYCLE_MINUTES, GENERATION_TARGET_MWH, GATE_HEAD_LIMIT_M } from "./sim.js";

const W = 1200;
const H = 620;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function levelY(level) {
  return 382 - (level - 0.8) * 42;
}

export class TidalRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = 1;
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(640, rect.width);
    const height = width * (H / W);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.height = `${height}px`;
    this.dpr = dpr;
    this.scale = width / W;
  }

  draw(sim, { replay = false } = {}) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(this.dpr * this.scale, this.dpr * this.scale);
    const state = sim.state;
    this.drawSky(state);
    this.drawShores(state);
    this.drawWater(state);
    this.drawBarrage(state);
    this.drawTurbines(state, sim.tick);
    this.drawSluice(state);
    this.drawLock(state);
    this.drawHead(state);
    this.drawFlowArrows(state, sim.tick);
    this.drawTrend(sim);
    this.drawHud(state, sim, replay);
  }

  drawSky(state) {
    const ctx = this.ctx;
    const gradient = ctx.createLinearGradient(0, 0, 0, 420);
    const night = Math.max(0, 1 - Math.abs(state.tick - 720) / 120);
    gradient.addColorStop(0, night > 0.6 ? "#0b1e2d" : "#0d2634");
    gradient.addColorStop(0.55, "#173f4b");
    gradient.addColorStop(1, "#2c5b5d");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, 500);

    const glow = ctx.createRadialGradient(908, 94, 6, 908, 94, 150);
    glow.addColorStop(0, "rgba(255, 206, 126, 0.36)");
    glow.addColorStop(1, "rgba(255, 190, 100, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(730, 0, 360, 300);
    ctx.fillStyle = "rgba(255, 220, 158, 0.82)";
    ctx.beginPath();
    ctx.arc(914, 86, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.07)";
    for (let index = 0; index < 11; index += 1) {
      const x = 100 + index * 93;
      const y = 30 + ((index * 37) % 82);
      ctx.beginPath();
      ctx.ellipse(x, y, 38, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(133, 196, 188, 0.18)";
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 60) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 460);
      ctx.stroke();
    }
  }

  drawShores() {
    const ctx = this.ctx;
    ctx.fillStyle = "#0a1720";
    ctx.beginPath();
    ctx.moveTo(0, 380);
    ctx.bezierCurveTo(90, 336, 150, 370, 245, 342);
    ctx.bezierCurveTo(310, 324, 355, 352, 386, 330);
    ctx.lineTo(386, 470);
    ctx.lineTo(0, 470);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#163b3e";
    ctx.beginPath();
    ctx.moveTo(760, 340);
    ctx.bezierCurveTo(850, 320, 920, 345, 1000, 326);
    ctx.bezierCurveTo(1090, 304, 1140, 320, 1200, 298);
    ctx.lineTo(1200, 470);
    ctx.lineTo(760, 470);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#0d242b";
    ctx.beginPath();
    ctx.moveTo(0, 436);
    ctx.lineTo(380, 392);
    ctx.lineTo(408, 422);
    ctx.lineTo(735, 422);
    ctx.lineTo(780, 392);
    ctx.lineTo(1200, 436);
    ctx.lineTo(1200, 510);
    ctx.lineTo(0, 510);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#1b4c49";
    ctx.fillRect(385, 318, 370, 112);
    ctx.fillStyle = "#12363a";
    ctx.fillRect(402, 388, 336, 44);
  }

  drawWater(state) {
    const ctx = this.ctx;
    const seaY = levelY(state.seaLevel);
    const basinY = levelY(state.basinLevel);

    const seaGradient = ctx.createLinearGradient(0, seaY, 0, 500);
    seaGradient.addColorStop(0, "rgba(48, 168, 174, 0.72)");
    seaGradient.addColorStop(1, "rgba(8, 50, 67, 0.92)");
    this.waterArea(0, 392, seaY, seaGradient, state.tick * 0.025);

    const basinGradient = ctx.createLinearGradient(0, basinY, 0, 500);
    basinGradient.addColorStop(0, "rgba(63, 180, 163, 0.68)");
    basinGradient.addColorStop(1, "rgba(10, 59, 60, 0.92)");
    this.waterArea(748, 1200, basinY, basinGradient, state.tick * 0.018 + 2);

    ctx.strokeStyle = "rgba(162, 241, 224, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= 390; x += 6) {
      const y = seaY + Math.sin(x * 0.045 + state.tick * 0.08) * 2;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let x = 748; x <= 1200; x += 6) {
      const y = basinY + Math.sin(x * 0.04 + state.tick * 0.06) * 2;
      if (x === 748) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(215, 242, 235, 0.8)";
    ctx.font = '600 12px "Noto Sans SC", sans-serif';
    ctx.fillText("外海 / SEA", 26, seaY - 12);
    ctx.fillText("库区 / BASIN", 1082, basinY - 12);
  }

  waterArea(x1, x2, y, fill, phase) {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x1, y);
    for (let x = x1; x <= x2; x += 8) {
      const wave = Math.sin(x * 0.035 + phase) * 2.2 +
        Math.sin(x * 0.071 - phase * 1.4) * 1.1;
      ctx.lineTo(x, y + wave);
    }
    ctx.lineTo(x2, 510);
    ctx.lineTo(x1, 510);
    ctx.closePath();
    ctx.fill();

    const shimmer = ctx.createLinearGradient(x1, y, x2, y + 90);
    shimmer.addColorStop(0, "rgba(255,255,255,0.10)");
    shimmer.addColorStop(0.35, "rgba(255,255,255,0.015)");
    shimmer.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = shimmer;
    ctx.fillRect(x1, y, x2 - x1, 110);
  }

  drawBarrage(state) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(7, 25, 31, 0.78)";
    roundedRect(ctx, 384, 286, 372, 158, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(111, 196, 183, 0.28)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#23484b";
    ctx.fillRect(394, 220, 342, 76);
    ctx.fillStyle = "#18383d";
    ctx.fillRect(404, 230, 322, 54);
    ctx.fillStyle = "rgba(117, 220, 204, 0.12)";
    for (let x = 416; x < 710; x += 34) {
      ctx.fillRect(x, 241, 22, 25);
    }
    ctx.fillStyle = state.safety.status === "fault" ? "#ff6e63" : "#72e5b3";
    ctx.beginPath();
    ctx.arc(427, 294, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(206, 235, 228, 0.9)";
    ctx.font = '700 11px "Noto Sans SC", sans-serif';
    ctx.fillText("潮汐主机房 · 3 × 3.3 MW", 441, 298);

    ctx.strokeStyle = "rgba(132, 200, 187, 0.18)";
    ctx.lineWidth = 1;
    for (let y = 310; y < 426; y += 14) {
      ctx.beginPath();
      ctx.moveTo(390, y);
      ctx.lineTo(752, y);
      ctx.stroke();
    }

    ctx.fillStyle = "#9cb9b2";
    ctx.font = '500 9px "Noto Sans SC", sans-serif';
    ctx.fillText("BARRAGE / 潮汐枢纽", 397, 438);
  }

  drawTurbines(state, tick) {
    const ctx = this.ctx;
    const turbine = state.turbine;
    const xs = [444, 505, 566];
    xs.forEach((x, index) => {
      const unit = state.units[index];
      const statusColor =
        unit.status === "online"
          ? "#62e0bd"
          : unit.status === "fault"
            ? "#ff665d"
            : "#ffc15c";
      const rotation = tick * 0.12 * turbine.speed * (turbine.direction === "ebb" ? -1 : 1);

      ctx.save();
      ctx.translate(x, 365);
      ctx.fillStyle = "#0b2027";
      ctx.beginPath();
      ctx.arc(0, 0, 29, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(143, 222, 207, 0.32)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.rotate(rotation);
      for (let blade = 0; blade < 6; blade += 1) {
        ctx.rotate(Math.PI / 3);
        ctx.fillStyle = turbine.status === "running"
          ? "rgba(111, 218, 196, 0.72)"
          : "rgba(125, 154, 153, 0.42)";
        ctx.beginPath();
        ctx.ellipse(0, -13, 5, 14, 0.18, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      ctx.fillStyle = "#092027";
      ctx.beginPath();
      ctx.arc(x, 365, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = statusColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(219, 241, 234, 0.7)";
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.fillText(`T${index + 1}`, x - 8, 400);
      ctx.fillStyle = statusColor;
      ctx.beginPath();
      ctx.arc(x + 14, 396, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });

    const directionText = turbine.status === "reversing"
      ? `换向 ${turbine.reverseLeft}m`
      : turbine.direction === "flood"
        ? "涨潮向 → 库区"
        : "落潮向 → 外海";
    ctx.fillStyle = "rgba(207, 238, 230, 0.8)";
    ctx.font = '600 10px "Noto Sans SC", sans-serif';
    ctx.fillText(directionText, 430, 414);
  }

  drawSluice(state) {
    const ctx = this.ctx;
    const gate = state.gate;
    const x = 626;
    const width = 98;
    ctx.fillStyle = "#102f35";
    ctx.fillRect(x, 309, width, 108);
    ctx.strokeStyle = "rgba(147, 206, 195, 0.25)";
    ctx.strokeRect(x + 0.5, 309.5, width - 1, 107);

    const panelY = 318 - gate.opening * 56;
    ctx.fillStyle = gate.interlocked ? "rgba(255, 94, 84, 0.72)" : "#496f70";
    for (let index = 0; index < 5; index += 1) {
      ctx.fillRect(x + 8 + index * 17, panelY, 11, 90);
    }
    ctx.strokeStyle = "rgba(213, 240, 233, 0.26)";
    ctx.beginPath();
    ctx.moveTo(x + 4, panelY);
    ctx.lineTo(x + width - 4, panelY);
    ctx.stroke();

    if (gate.opening > 0.01) {
      const seaHigher = state.seaLevel > state.basinLevel;
      const startX = seaHigher ? x + width + 5 : x - 5;
      const endX = seaHigher ? x + width + 28 : x - 28;
      const waterY = levelY(seaHigher ? state.basinLevel : state.seaLevel);
      const jet = ctx.createLinearGradient(startX, waterY - 40, endX, waterY + 10);
      jet.addColorStop(0, "rgba(154, 238, 222, 0.75)");
      jet.addColorStop(1, "rgba(154, 238, 222, 0)");
      ctx.strokeStyle = jet;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(startX, 354);
      ctx.quadraticCurveTo(endX, 380, endX, waterY);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(207, 238, 230, 0.72)";
    ctx.font = '600 9px "Noto Sans SC", sans-serif';
    ctx.fillText("泄水闸", x + 25, 438);
    ctx.fillStyle = gate.margin < 0 ? "#ff776d" : "#8ce1ca";
    ctx.fillText(`Δp ${Math.abs(state.head).toFixed(2)} m`, x + 12, 302);
  }

  drawLock(state) {
    const ctx = this.ctx;
    const x = 894;
    const y = 260;
    const width = 220;
    const height = 180;
    const lock = state.lock;
    ctx.fillStyle = "rgba(9, 31, 36, 0.82)";
    roundedRect(ctx, x, y, width, height, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(142, 211, 198, 0.35)";
    ctx.stroke();
    ctx.fillStyle = "rgba(41, 106, 111, 0.65)";
    ctx.fillRect(x + 12, y + 24, width - 24, height - 48);

    const chamberWater = levelY(state.basinLevel);
    ctx.fillStyle = "rgba(56, 168, 158, 0.42)";
    ctx.fillRect(x + 12, Math.max(y + 32, chamberWater), width - 24, y + height - 12 - chamberWater);

    const innerLeft = x + 18;
    const innerRight = x + width - 18;
    ctx.fillStyle = "#35595b";
    ctx.fillRect(innerLeft - 5, y + 22, 5, height - 36);
    ctx.fillRect(innerRight, y + 22, 5, height - 36);
    const leftGate = clamp(state.seaLevel - state.basinLevel + 0.5, 0, 1);
    const rightGate = 1 - leftGate;
    ctx.fillStyle = "#71948f";
    ctx.fillRect(innerLeft, y + 22, 4, 60 * rightGate + 20);
    ctx.fillRect(innerRight - 4, y + 22, 4, 60 * leftGate + 20);

    if (lock.phase !== "idle") {
      let boatX = x + 65;
      let boatY = y + height - 54;
      if (lock.phase === "approach") {
        boatX = x - 48;
      } else if (lock.phase === "equalize") {
        boatX = x + 20;
      } else if (lock.phase === "transit") {
        boatX = x + 20 + (width - 90) * lock.transitProgress;
      } else if (lock.phase === "exit") {
        boatX = x + width - 54;
      }
      this.drawBoat(boatX, boatY);
    }

    ctx.fillStyle = "rgba(207, 238, 230, 0.85)";
    ctx.font = '700 11px "Noto Sans SC", sans-serif';
    ctx.fillText("船闸 / SHIP LOCK", x + 50, y + 17);
    const lockLabel = {
      idle: "待命",
      approach: lock.waitingForHead ? "等待均压" : "进闸",
      equalize: "闸室均压",
      transit: "船舶过闸",
      exit: "恢复闸门",
    }[lock.phase] ?? "待命";
    ctx.fillStyle = lock.waitingForHead ? "#ffc15c" : "#75ddbf";
    ctx.font = '600 10px "Noto Sans SC", sans-serif';
    ctx.fillText(lockLabel, x + 154, y + 17);
  }

  drawBoat(x, y) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "#d8b067";
    ctx.beginPath();
    ctx.moveTo(0, 8);
    ctx.lineTo(45, 8);
    ctx.lineTo(36, 18);
    ctx.lineTo(7, 18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f0e5c7";
    ctx.fillRect(12, -3, 21, 10);
    ctx.fillStyle = "#84c7ba";
    ctx.fillRect(16, 0, 5, 4);
    ctx.fillRect(24, 0, 5, 4);
    ctx.fillStyle = "#5d4630";
    ctx.fillRect(34, -6, 3, 13);
    ctx.restore();
  }

  drawHead(state) {
    const ctx = this.ctx;
    const seaY = levelY(state.seaLevel);
    const basinY = levelY(state.basinLevel);
    const x = 790;
    const top = Math.min(seaY, basinY);
    const bottom = Math.max(seaY, basinY);
    ctx.strokeStyle = "rgba(255, 204, 126, 0.76)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(755, seaY);
    ctx.lineTo(844, seaY);
    ctx.moveTo(755, basinY);
    ctx.lineTo(844, basinY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.moveTo(x - 5, top + 7);
    ctx.lineTo(x, top);
    ctx.lineTo(x + 5, top + 7);
    ctx.moveTo(x - 5, bottom - 7);
    ctx.lineTo(x, bottom);
    ctx.lineTo(x + 5, bottom - 7);
    ctx.stroke();

    const labelY = (top + bottom) / 2;
    ctx.fillStyle = "rgba(8, 28, 33, 0.88)";
    roundedRect(ctx, x - 46, labelY - 17, 92, 30, 4);
    ctx.fill();
    ctx.fillStyle = "#ffd08a";
    ctx.font = '700 12px "IBM Plex Mono", monospace';
    ctx.textAlign = "center";
    ctx.fillText(`H ${Math.abs(state.head).toFixed(2)} m`, x, labelY + 3);
    ctx.textAlign = "left";
  }

  drawFlowArrows(state, tick) {
    const ctx = this.ctx;
    const flow = state.flow.total;
    if (Math.abs(flow) < 4) return;
    const direction = Math.sign(flow);
    const count = clamp(Math.round(Math.abs(flow) / 65), 2, 12);
    const seaHigher = state.seaLevel > state.basinLevel;
    for (let index = 0; index < count; index += 1) {
      const progress = ((tick * 0.011 * direction + index / count) % 1 + 1) % 1;
      const x = seaHigher
        ? 340 + progress * 455
        : 795 - progress * 455;
      const y = 330 + Math.sin(index * 2.7) * 9;
      const px = state.turbine.status === "running" ? x : 390 + progress * 350;
      ctx.fillStyle = "rgba(111, 231, 207, 0.48)";
      ctx.beginPath();
      ctx.arc(px, y, 1.8 + Math.abs(flow) / 900, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(214, 241, 234, 0.78)";
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillText(
      `${flow > 0 ? "海→库" : "库→海"} ${Math.abs(flow).toFixed(0)} m³/s`,
      526,
      456,
    );
  }

  drawTrend(sim) {
    const ctx = this.ctx;
    const x = 34;
    const y = 526;
    const width = 1132;
    const height = 72;
    ctx.fillStyle = "rgba(5, 21, 27, 0.84)";
    roundedRect(ctx, x, y, width, height, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(118, 190, 178, 0.18)";
    ctx.stroke();

    const points = sim.history.length > 1 ? sim.history : [sim.historyPoint()];
    const px = (tick) => x + 58 + (tick / CYCLE_MINUTES) * (width - 78);
    const py = (level) => y + height - 11 - ((level - 0.8) / 5.5) * (height - 26);

    ctx.strokeStyle = "rgba(163, 218, 207, 0.16)";
    ctx.lineWidth = 1;
    for (let tick = 0; tick <= CYCLE_MINUTES; tick += 180) {
      const xx = px(tick);
      ctx.beginPath();
      ctx.moveTo(xx, y + 10);
      ctx.lineTo(xx, y + height - 10);
      ctx.stroke();
    }

    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "#ffc36f";
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(px(point.tick), py(point.sea));
      else ctx.lineTo(px(point.tick), py(point.sea));
    });
    ctx.stroke();
    ctx.strokeStyle = "#64d8c2";
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(px(point.tick), py(point.basin));
      else ctx.lineTo(px(point.tick), py(point.basin));
    });
    ctx.stroke();

    const currentX = px(sim.tick);
    ctx.strokeStyle = "rgba(236, 248, 244, 0.54)";
    ctx.beginPath();
    ctx.moveTo(currentX, y + 8);
    ctx.lineTo(currentX, y + height - 8);
    ctx.stroke();
    ctx.fillStyle = "rgba(231, 246, 241, 0.9)";
    ctx.beginPath();
    ctx.arc(currentX, y + 8, 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(206, 235, 228, 0.68)";
    ctx.font = '600 9px "Noto Sans SC", sans-serif';
    ctx.fillText("潮位 / 库位曲线", x + 11, y + 15);
    ctx.fillStyle = "#ffc36f";
    ctx.fillRect(x + 107, y + 9, 12, 2);
    ctx.fillText("外海", x + 123, y + 12);
    ctx.fillStyle = "#64d8c2";
    ctx.fillRect(x + 155, y + 9, 12, 2);
    ctx.fillText("库区", x + 171, y + 12);
    ctx.fillStyle = "rgba(190, 224, 216, 0.54)";
    ctx.textAlign = "right";
    ctx.fillText("06:00", x + 55, y + 15);
    ctx.fillText("18:00", x + width - 7, y + 15);
    ctx.textAlign = "left";
  }

  drawHud(state, sim, replay) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(4, 20, 26, 0.72)";
    roundedRect(ctx, 24, 20, 268, 52, 6);
    ctx.fill();
    ctx.strokeStyle = "rgba(107, 204, 189, 0.22)";
    ctx.stroke();
    ctx.fillStyle = sim.strategy.color;
    ctx.font = '700 13px "Noto Sans SC", sans-serif';
    ctx.fillText(sim.strategy.name, 40, 42);
    ctx.fillStyle = "rgba(216, 239, 233, 0.68)";
    ctx.font = '500 10px "Noto Sans SC", sans-serif';
    ctx.fillText(`${sim.scenario.name} · 固定步长 1 min`, 40, 59);

    if (replay) {
      ctx.fillStyle = "rgba(255, 190, 94, 0.92)";
      roundedRect(ctx, 300, 29, 82, 34, 5);
      ctx.fill();
      ctx.fillStyle = "#10272c";
      ctx.font = '800 12px "Noto Sans SC", sans-serif';
      ctx.fillText("故障回放", 316, 51);
    }

    const clock = state.clock;
    ctx.textAlign = "right";
    ctx.fillStyle = "#effaf6";
    ctx.font = '700 26px "IBM Plex Mono", monospace';
    ctx.fillText(clock, 1175, 44);
    ctx.fillStyle = "rgba(196, 230, 222, 0.62)";
    ctx.font = '600 10px "Noto Sans SC", sans-serif';
    ctx.fillText(`${state.tidePhase} · 周期 ${Math.min(100, Math.round(sim.tick / CYCLE_MINUTES * 100))}%`, 1175, 62);
    ctx.textAlign = "left";

    if (sim.incidents.some((incident) => !incident.resolved)) {
      const incident = [...sim.incidents].reverse().find((item) => !item.resolved);
      ctx.fillStyle = "rgba(185, 46, 42, 0.9)";
      roundedRect(ctx, 24, 84, 468, 34, 4);
      ctx.fill();
      ctx.fillStyle = "#fff4ed";
      ctx.font = '700 12px "Noto Sans SC", sans-serif';
      ctx.fillText(`联锁 · ${incident.title} · ${incident.clock} · 余量 ${incident.margin}${incident.unit}`, 38, 106);
    } else if (sim.audit.active) {
      ctx.fillStyle = "rgba(31, 119, 103, 0.88)";
      roundedRect(ctx, 24, 84, 468, 34, 4);
      ctx.fill();
      ctx.fillStyle = "#e6fff7";
      ctx.font = '700 12px "Noto Sans SC", sans-serif';
      ctx.fillText(
        `长稳校验 ${sim.audit.elapsed}/${sim.audit.required} min · 当前无新增联锁`,
        38,
        106,
      );
    }

    const badPressure = Math.abs(state.head) > GATE_HEAD_LIMIT_M && state.gate.opening > 0.005;
    if (badPressure) {
      ctx.strokeStyle = "rgba(255, 92, 81, 0.8)";
      ctx.lineWidth = 2;
      ctx.strokeRect(3, 3, W - 6, H - 6);
    }

    const energyRatio = state.energyMWh / GENERATION_TARGET_MWH;
    ctx.fillStyle = "rgba(4, 20, 26, 0.72)";
    roundedRect(ctx, 1000, 84, 176, 34, 4);
    ctx.fill();
    ctx.fillStyle = energyRatio >= 1 ? "#76e3b4" : "#ffca72";
    ctx.font = '700 11px "IBM Plex Mono", monospace';
    ctx.fillText(`E ${state.energyMWh.toFixed(1)} / ${GENERATION_TARGET_MWH} MWh`, 1012, 105);
  }
}
