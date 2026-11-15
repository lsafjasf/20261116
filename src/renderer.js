import { LIMITS, PHASE, axisTelemetry, seedToUint32 } from "./sim.js";

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function wedgePath(ctx, x, y, radius, from, to) {
  ctx.beginPath();
  ctx.arc(x, y, radius, from, to);
}

export class SpaceRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.stars = [];
    this.starSeed = null;
    this.flash = 0;
    this.lastPhase = null;
    this.resize = this.resize.bind(this);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(320, rect.width);
    this.height = Math.max(420, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.makeStars();
  }

  makeStars(seed = "stars") {
    if (this.starSeed === seed && this.stars.length) {
      return;
    }
    this.starSeed = seed;
    const random = hashRandom(seedToUint32(seed));
    const count = Math.floor((this.width * this.height) / 5200);
    this.stars = Array.from({ length: count }, () => ({
      x: random() * this.width,
      y: random() * this.height,
      r: 0.25 + random() * 1.25,
      a: 0.16 + random() * 0.55,
      phase: random() * TAU,
    }));
  }

  geometry(state) {
    const landscape = this.width > 900;
    const port = {
      x: landscape ? this.width * 0.695 : this.width * 0.67,
      y: landscape ? this.height * 0.46 : this.height * 0.49,
    };
    const maxAxisPixels = landscape ? this.width * 0.48 : this.width * 0.43;
    const distancePixels = clamp(state.d * 18, 26, maxAxisPixels);
    const scale = landscape ? 22 : 17;
    const module = {
      x: port.x - distancePixels + state.x * scale + state.portOffset.x * 6,
      y: port.y + state.y * scale + state.portOffset.y * 6,
      angle: Math.atan2(port.y - (port.y + state.y * scale), port.x - (port.x - distancePixels)),
    };
    return { port, module, distancePixels, scale };
  }

  draw(state, { paused = false, replay = false, now = performance.now() } = {}) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (state.phase !== this.lastPhase) {
      this.flash = 1;
      this.lastPhase = state.phase;
    }
    this.flash *= 0.93;
    this.makeStars(state.seed);

    ctx.clearRect(0, 0, w, h);
    this.drawBackdrop(ctx, state, now, w, h);
    const geometry = this.geometry(state);
    this.drawStation(ctx, geometry, state, now);
    this.drawCorridor(ctx, geometry, state, now);
    this.drawTargetCones(ctx, geometry, state, now);
    this.drawModule(ctx, geometry, state, now);
    this.drawTelemetryLines(ctx, geometry, state);
    this.drawAxisInstruments(ctx, state, now);
    this.drawFrameMarks(ctx, state, paused, replay);
    return geometry;
  }

  drawBackdrop(ctx, state, now, w, h) {
    const glow = ctx.createRadialGradient(w * 0.72, h * 0.44, 10, w * 0.72, h * 0.44, w * 0.5);
    glow.addColorStop(0, "rgba(23, 87, 73, 0.16)");
    glow.addColorStop(0.55, "rgba(7, 31, 27, 0.08)");
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    for (const star of this.stars) {
      const shimmer = 0.65 + Math.sin(now * 0.001 + star.phase) * 0.35;
      ctx.globalAlpha = star.a * (0.55 + shimmer * 0.45);
      ctx.fillStyle = star.r > 1.1 ? "#bafff0" : "#d7e9e5";
      ctx.fillRect(star.x, star.y, star.r, star.r);
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(-w * 0.11, h * 0.85);
    ctx.rotate(-0.22);
    const planetGlow = ctx.createRadialGradient(0, 0, h * 0.18, 0, 0, h * 0.52);
    planetGlow.addColorStop(0, "rgba(19, 47, 54, 0.26)");
    planetGlow.addColorStop(0.72, "rgba(6, 17, 20, 0.1)");
    planetGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = planetGlow;
    ctx.beginPath();
    ctx.arc(0, 0, h * 0.52, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(78, 141, 159, 0.15)";
    ctx.lineWidth = 1;
    for (let ring = 0; ring < 5; ring += 1) {
      ctx.beginPath();
      ctx.ellipse(0, 0, h * (0.36 + ring * 0.05), h * (0.23 + ring * 0.035), 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    this.drawOrbit(ctx, w, h, 0.1, now);
    const drift = state.lastDrift;
    if (drift) {
      const age = clamp((state.tick - drift.tick) / 150, 0, 1);
      if (age < 1) {
        ctx.strokeStyle = `rgba(255, 181, 94, ${(1 - age) * 0.28})`;
        ctx.lineWidth = 1;
        for (let index = 0; index < 4; index += 1) {
          const y = h * 0.2 + index * 39 + Math.sin(now * 0.002 + index) * 6;
          ctx.beginPath();
          ctx.moveTo(w * 0.3, y);
          ctx.lineTo(w * (0.55 + age * 0.3), y + 18);
          ctx.stroke();
        }
      }
    }
  }

  drawOrbit(ctx, w, h, rotate, now) {
    ctx.save();
    ctx.translate(w * 0.52, h * 0.42);
    ctx.rotate(rotate);
    ctx.strokeStyle = "rgba(94, 198, 177, 0.09)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 11]);
    for (let ring = 0; ring < 3; ring += 1) {
      ctx.beginPath();
      ctx.ellipse(0, 0, w * (0.3 + ring * 0.1), h * (0.16 + ring * 0.075), -0.36, 0, TAU);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(102, 239, 198, 0.2)";
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.405, h * 0.285, -0.36, -1.2, 1.55);
    ctx.stroke();
    const angle = -0.1 + Math.sin(now * 0.00008) * 0.05;
    const sx = Math.cos(angle) * w * 0.405;
    const sy = Math.sin(angle) * h * 0.285;
    ctx.fillStyle = "rgba(186, 255, 240, 0.75)";
    ctx.beginPath();
    ctx.arc(sx, sy, 1.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawStation(ctx, geometry, state, now) {
    const { port } = geometry;
    const cx = port.x + 80;
    const cy = port.y;
    ctx.save();
    ctx.translate(cx, cy);

    ctx.strokeStyle = "rgba(126, 171, 161, 0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, 83, 41, -0.16, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(6, -2, 60, 28, -0.16, 0, TAU);
    ctx.stroke();

    ctx.fillStyle = "rgba(11, 25, 23, 0.94)";
    ctx.strokeStyle = "rgba(151, 190, 181, 0.4)";
    ctx.fillRect(-21, -20, 43, 40);
    ctx.strokeRect(-21, -20, 43, 40);
    ctx.fillStyle = "rgba(43, 70, 63, 0.6)";
    ctx.fillRect(-14, -13, 17, 8);
    ctx.fillRect(5, 7, 10, 8);
    ctx.strokeStyle = "rgba(102, 239, 198, 0.18)";
    for (let x = -78; x <= 78; x += 13) {
      ctx.beginPath();
      ctx.moveTo(x, -29);
      ctx.lineTo(x + 5, -18);
      ctx.stroke();
    }

    const pulse = 0.55 + Math.sin(now * 0.005) * 0.25;
    ctx.shadowColor = "#66efc6";
    ctx.shadowBlur = 13;
    ctx.strokeStyle = `rgba(102, 239, 198, ${pulse})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(-80, 0, 18, 0, TAU);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(102, 239, 198, 0.22)";
    ctx.beginPath();
    ctx.arc(-80, 0, 27, 0, TAU);
    ctx.stroke();

    ctx.strokeStyle = "rgba(111, 139, 133, 0.35)";
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(-112, -34);
    ctx.lineTo(-112, 34);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#4f6a64";
    ctx.font = "8px monospace";
    ctx.fillText("KESTREL-7", -63, 55);
    ctx.restore();
  }

  drawCorridor(ctx, geometry, state, now) {
    const { port, module, distancePixels } = geometry;
    const alpha = state.phase === PHASE.FAILED ? 0.25 : 0.18;
    ctx.strokeStyle = `rgba(102, 239, 198, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 7]);
    ctx.beginPath();
    ctx.moveTo(module.x, module.y);
    ctx.lineTo(port.x, port.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const half = Math.max(26, distancePixels * 0.14);
    ctx.strokeStyle = "rgba(102, 239, 198, 0.08)";
    ctx.beginPath();
    ctx.moveTo(port.x, port.y - half);
    ctx.lineTo(port.x - distancePixels, port.y - half * 1.4);
    ctx.moveTo(port.x, port.y + half);
    ctx.lineTo(port.x - distancePixels, port.y + half * 1.4);
    ctx.stroke();

    ctx.fillStyle = "rgba(102, 239, 198, 0.47)";
    ctx.font = "8px monospace";
    ctx.fillText(`RANGE ${state.d.toFixed(2)} m`, port.x - distancePixels * 0.56, port.y + half * 1.7);
    const closing = -state.vd;
    ctx.fillStyle = closing > 0.35 ? "rgba(255,181,94,.65)" : "rgba(102,239,198,.55)";
    ctx.fillText(`V-AXIS ${closing >= 0 ? "+" : ""}${closing.toFixed(2)} m/s`, port.x - distancePixels * 0.56, port.y + half * 1.7 + 12);

    for (let index = 1; index < 5; index += 1) {
      const t = index / 5;
      const x = port.x - distancePixels * t;
      ctx.fillStyle = "rgba(130, 176, 165, 0.22)";
      ctx.fillRect(x, port.y - 4, 1, 8);
    }
    const scan = (now * 0.045) % distancePixels;
    ctx.fillStyle = "rgba(102, 239, 198, 0.06)";
    ctx.fillRect(port.x - scan, port.y - half * 1.4, 2, half * 2.8);
  }

  drawTargetCones(ctx, geometry, state, now) {
    const { port, module, distancePixels } = geometry;
    const telemetry = axisTelemetry(state);
    const color =
      state.phase === PHASE.FAILED
        ? "255, 101, 95"
        : telemetry.allIn
          ? "102, 239, 198"
          : "255, 181, 94";
    const halfWidth = Math.max(16, distancePixels * Math.tan((LIMITS.bearingDeg * Math.PI) / 180) * 12);

    const gradient = ctx.createLinearGradient(module.x, module.y, port.x, port.y);
    gradient.addColorStop(0, `rgba(${color}, 0.01)`);
    gradient.addColorStop(1, `rgba(${color}, 0.16)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(port.x, port.y);
    ctx.lineTo(module.x, module.y - halfWidth);
    ctx.lineTo(module.x, module.y + halfWidth);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = `rgba(${color}, 0.35)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(port.x, port.y);
    ctx.lineTo(module.x, module.y - halfWidth);
    ctx.moveTo(port.x, port.y);
    ctx.lineTo(module.x, module.y + halfWidth);
    ctx.stroke();

    ctx.strokeStyle = `rgba(${color}, 0.75)`;
    ctx.beginPath();
    ctx.arc(port.x, port.y, 9 + Math.sin(now * 0.005) * (telemetry.allIn ? 2.4 : 1), 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(${color}, 0.9)`;
    ctx.fillRect(port.x - 1, port.y - 15, 2, 7);
    ctx.fillRect(port.x - 1, port.y + 8, 2, 7);
    ctx.fillRect(port.x - 15, port.y - 1, 7, 2);
    ctx.fillRect(port.x + 8, port.y - 1, 7, 2);
  }

  drawModule(ctx, geometry, state, now) {
    const { module } = geometry;
    const failed = state.phase === PHASE.FAILED;
    const locked = state.phase === PHASE.LATCHING || state.phase === PHASE.TRANSFER;
    ctx.save();
    ctx.translate(module.x, module.y);
    ctx.rotate(-0.035);

    if (state.commands.throttle > 0.04 && !failed) {
      const flame = 10 + state.commands.throttle * 28 + Math.sin(now * 0.03) * 5;
      const flameGradient = ctx.createLinearGradient(-27, 0, -27 - flame, 0);
      flameGradient.addColorStop(0, "rgba(160, 255, 227, 0.9)");
      flameGradient.addColorStop(0.35, "rgba(102, 239, 198, 0.6)");
      flameGradient.addColorStop(1, "rgba(102, 239, 198, 0)");
      ctx.fillStyle = flameGradient;
      ctx.beginPath();
      ctx.moveTo(-25, -5);
      ctx.lineTo(-25 - flame, 0);
      ctx.lineTo(-25, 5);
      ctx.closePath();
      ctx.fill();
    }
    if (state.commands.throttle < -0.04 && !failed) {
      ctx.fillStyle = "rgba(114, 183, 255, 0.45)";
      ctx.fillRect(23, -2, 4 + Math.abs(state.commands.throttle) * 11, 4);
    }

    ctx.fillStyle = failed ? "rgba(64, 25, 23, 0.96)" : "rgba(17, 34, 31, 0.98)";
    ctx.strokeStyle = failed ? "#ff655f" : "#8fc9bb";
    ctx.lineWidth = 1.25;
    ctx.fillRect(-26, -15, 52, 30);
    ctx.strokeRect(-26, -15, 52, 30);
    ctx.fillStyle = failed ? "#ff655f" : "rgba(102, 239, 198, 0.18)";
    ctx.fillRect(-19, -10, 15, 20);
    ctx.fillRect(6, -8, 11, 16);
    ctx.strokeStyle = "rgba(204, 237, 229, 0.35)";
    ctx.strokeRect(22, -5, 8, 10);

    ctx.strokeStyle = "rgba(102, 239, 198, 0.38)";
    ctx.beginPath();
    ctx.moveTo(-7, 0);
    ctx.lineTo(13, 0);
    ctx.moveTo(3, -4);
    ctx.lineTo(3, 4);
    ctx.stroke();

    ctx.fillStyle = "rgba(113, 138, 132, 0.47)";
    ctx.fillRect(-23, -27, 46, 3);
    ctx.fillRect(-23, 24, 46, 3);
    ctx.strokeStyle = "rgba(102, 239, 198, 0.14)";
    for (let index = -20; index <= 20; index += 7) {
      ctx.beginPath();
      ctx.moveTo(index, -26);
      ctx.lineTo(index, -20);
      ctx.moveTo(index, 20);
      ctx.lineTo(index, 26);
      ctx.stroke();
    }

    if (state.commands.yaw) {
      ctx.fillStyle = "rgba(102, 239, 198, 0.55)";
      ctx.fillRect(state.commands.yaw > 0 ? 17 : -21, -18, 4, 3);
    }
    if (state.commands.pitch) {
      ctx.fillStyle = "rgba(102, 239, 198, 0.55)";
      ctx.fillRect(state.commands.pitch > 0 ? -2 : -2, state.commands.pitch > 0 ? 18 : -21, 4, 3);
    }

    if (locked) {
      ctx.strokeStyle = `rgba(102, 239, 198, ${0.75 + Math.sin(now * 0.01) * 0.2})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(-31, -20, 62, 40);
    }
    ctx.restore();

    ctx.fillStyle = "rgba(197, 229, 221, 0.72)";
    ctx.font = "8px monospace";
    ctx.fillText("SERVICE MODULE / M-47", module.x - 38, module.y + 43);
  }

  drawTelemetryLines(ctx, geometry, state) {
    const { port, module } = geometry;
    ctx.save();
    ctx.strokeStyle = "rgba(102, 239, 198, 0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 5]);
    ctx.beginPath();
    ctx.moveTo(module.x, module.y);
    ctx.lineTo(module.x, port.y);
    ctx.moveTo(module.x, module.y);
    ctx.lineTo(port.x, module.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = "rgba(102, 239, 198, 0.34)";
    ctx.beginPath();
    ctx.moveTo(module.x - 5, module.y);
    ctx.lineTo(module.x + 5, module.y);
    ctx.moveTo(module.x, module.y - 5);
    ctx.lineTo(module.x, module.y + 5);
    ctx.stroke();
    ctx.font = "8px monospace";
    ctx.fillStyle = "rgba(132, 176, 165, 0.6)";
    ctx.fillText(`ΔX ${state.x >= 0 ? "+" : ""}${state.x.toFixed(2)}`, module.x - 18, module.y - 22);
    ctx.fillText(`ΔY ${state.y >= 0 ? "+" : ""}${state.y.toFixed(2)}`, module.x + 6, module.y + 35);
    ctx.restore();
  }

  drawGauge(ctx, x, y, radius, label, english, value, normalized, tolerance, valueText, color) {
    const start = Math.PI * 0.76;
    const end = Math.PI * 2.24;
    const angle = start + ((clamp(normalized, -1, 1) + 1) / 2) * (end - start);
    const toleranceAngle = (tolerance / 2) * (end - start);
    ctx.save();
    ctx.translate(x, y);

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(120, 158, 150, 0.16)";
    wedgePath(ctx, 0, 0, radius, start, end);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(102, 239, 198, 0.14)";
    wedgePath(ctx, 0, 0, radius - 2, Math.PI * 1.5 - toleranceAngle, Math.PI * 1.5 + toleranceAngle);
    ctx.stroke();

    for (let index = 0; index <= 12; index += 1) {
      const tickAngle = start + (index / 12) * (end - start);
      const major = index === 0 || index === 6 || index === 12;
      const inner = radius - (major ? 8 : 4);
      ctx.strokeStyle = major ? "rgba(192, 224, 216, 0.55)" : "rgba(123, 158, 150, 0.24)";
      ctx.beginPath();
      ctx.moveTo(Math.cos(tickAngle) * inner, Math.sin(tickAngle) * inner);
      ctx.lineTo(Math.cos(tickAngle) * (radius + 1), Math.sin(tickAngle) * (radius + 1));
      ctx.stroke();
    }

    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(angle) * (radius - 10), Math.sin(angle) * (radius - 10));
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, TAU);
    ctx.fill();

    ctx.textAlign = "center";
    ctx.fillStyle = "#70847f";
    ctx.font = "8px monospace";
    ctx.fillText(english, 0, radius + 15);
    ctx.fillStyle = "#c7ddd7";
    ctx.font = "10px sans-serif";
    ctx.fillText(label, 0, radius + 27);
    ctx.fillStyle = color;
    ctx.font = "9px monospace";
    ctx.fillText(valueText, 0, radius + 39);
    ctx.restore();
  }

  drawAxisInstruments(ctx, state, now) {
    const telemetry = axisTelemetry(state);
    const mobile = this.width < 620;
    const radius = mobile ? 25 : 31;
    const gap = mobile ? 90 : 132;
    const x = mobile ? this.width / 2 : this.width * 0.58;
    const y = this.height - (mobile ? 142 : 132);
    const items = [
      {
        label: "方位",
        english: "BEARING",
        value: telemetry.bearing,
        normalized: telemetry.bearing / 4,
        tolerance: LIMITS.bearingDeg / 2,
        text: `${telemetry.bearing >= 0 ? "+" : ""}${telemetry.bearing.toFixed(2)}°`,
        ok: telemetry.bearingIn,
      },
      {
        label: "俯仰",
        english: "PITCH",
        value: telemetry.pitch,
        normalized: telemetry.pitch / 3.2,
        tolerance: LIMITS.pitchDeg / 1.6,
        text: `${telemetry.pitch >= 0 ? "+" : ""}${telemetry.pitch.toFixed(2)}°`,
        ok: telemetry.pitchIn,
      },
      {
        label: "推进",
        english: "THRUST",
        value: telemetry.axialSpeed,
        normalized: telemetry.axialSpeed / 1.2,
        tolerance: LIMITS.axialSpeed / 0.6,
        text: `${telemetry.range.toFixed(2)} m`,
        ok: telemetry.rangeIn && telemetry.speedIn,
      },
    ];
    items.forEach((item, index) => {
      const color =
        state.phase === PHASE.FAILED
          ? "#ff655f"
          : item.ok
            ? "#66efc6"
            : state.phase === PHASE.HOLD
              ? "#ffb55e"
              : "#89ada4";
      this.drawGauge(
        ctx,
        x + (index - 1) * gap,
        y,
        radius,
        item.label,
        item.english,
        item.value,
        item.normalized,
        item.tolerance,
        item.text,
        color,
      );
    });
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(113, 151, 142, 0.45)";
    ctx.font = "8px monospace";
    ctx.fillText(`SYNC ${axisTelemetry(state).allIn ? "TRUE" : "FALSE"}`, x - 53, y - 53);
    ctx.fillStyle = axisTelemetry(state).allIn ? "#66efc6" : "#6f8982";
    ctx.fillRect(x + 4, y - 57, 19, 2);
    const pulse = 0.4 + Math.sin(now * 0.006) * 0.2;
    ctx.fillStyle = `rgba(102, 239, 198, ${pulse})`;
    ctx.fillText(`MISSION T+${state.elapsed.toFixed(1)}`, x - 53, y - 43);
  }

  drawFrameMarks(ctx, state, paused, replay) {
    const w = this.width;
    const h = this.height;
    ctx.strokeStyle = "rgba(102, 239, 198, 0.22)";
    ctx.lineWidth = 1;
    const corner = 18;
    const inset = 13;
    for (const [x, y, dx, dy] of [
      [inset, inset, 1, 1],
      [w - inset, inset, -1, 1],
      [inset, h - inset, 1, -1],
      [w - inset, h - inset, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * corner, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * corner);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(121, 165, 155, 0.4)";
    ctx.font = "8px monospace";
    ctx.fillText(`TRI-AXIS / ${state.dockNumber === 1 ? "PORT-A" : "PORT-B"}`, 25, h - 24);
    ctx.textAlign = "right";
    ctx.fillText(`DRIFT ${String(state.driftSerial).padStart(2, "0")}`, w - 25, h - 24);
    ctx.textAlign = "left";

    if (paused || replay) {
      const text = replay ? "REPLAY // DETERMINISTIC" : "PAUSED // SIMULATION FROZEN";
      ctx.fillStyle = "rgba(3, 12, 10, 0.68)";
      ctx.fillRect(w / 2 - 105, 70, 210, 22);
      ctx.strokeStyle = replay ? "rgba(114, 183, 255, 0.45)" : "rgba(255, 181, 94, 0.45)";
      ctx.strokeRect(w / 2 - 105, 70, 210, 22);
      ctx.fillStyle = replay ? "#72b7ff" : "#ffb55e";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      ctx.fillText(text, w / 2, 85);
      ctx.textAlign = "left";
    }
  }
}
