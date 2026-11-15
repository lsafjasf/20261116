import {
  MATERIAL_LIST,
  MATERIALS,
  MAX_EXPOSURE,
  MAX_RANGE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./config.js";
import { materialForTile, tileAt } from "./world.js";

const TAU = Math.PI * 2;
const MONO = '"SFMono-Regular", Consolas, monospace';
const SANS =
  '"Avenir Next", "Segoe UI", "PingFang SC", "Microsoft YaHei", "WenQuanYi Micro Hei", "Noto Sans CJK SC", sans-serif';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function rgba(hex, alpha) {
  const value = hex.replace("#", "");
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(360, Math.round(rect.height));
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  render(game, audioState = null) {
    this.resize();
    const { ctx, width, height } = this;
    const state = game.state;
    ctx.clearRect(0, 0, width, height);
    this.drawBackdrop(state);
    if (state.revealMap) {
      this.drawTrueMap(game);
    } else {
      this.drawSonarView(game, audioState);
    }
  }

  drawBackdrop(state) {
    const { ctx, width, height } = this;
    const gradient = ctx.createRadialGradient(
      width * 0.38,
      height * 0.48,
      0,
      width * 0.38,
      height * 0.48,
      width * 0.78,
    );
    gradient.addColorStop(0, state.status === "FAILED" ? "#251113" : "#0b2226");
    gradient.addColorStop(0.5, "#061317");
    gradient.addColorStop(1, "#03090b");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(105, 161, 157, 0.05)";
    ctx.lineWidth = 1;
    const grid = 34;
    for (let x = 0; x < width; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = 0; y < height; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  drawSonarView(game, audioState) {
    const state = game.state;
    const { width, height } = this;
    const compact = width < 690;
    const margin = compact ? 18 : 24;
    const scopeRadius = compact
      ? Math.min(width * 0.41, height * 0.32, 190)
      : Math.min(height * 0.39, width * 0.27, 215);
    const centerX = compact ? width * 0.5 : margin + scopeRadius + 4;
    const centerY = compact ? margin + scopeRadius + 18 : height * 0.5;
    const panel = compact
      ? {
          x: margin,
          y: height - 118,
          width: width - margin * 2,
          height: 96,
        }
      : {
          x: centerX + scopeRadius + 30,
          y: Math.max(38, centerY - scopeRadius * 0.88),
          width: width - (centerX + scopeRadius + 30) - margin,
          height: Math.min(scopeRadius * 1.72, height - 88),
        };

    this.drawScope(state, centerX, centerY, scopeRadius);
    this.drawTopReadout(state, centerX - scopeRadius, centerY - scopeRadius - 30);
    this.drawWavePanel(state, panel, audioState);
    if (!compact) this.drawCompass(state, centerX, centerY + scopeRadius + 34);
  }

  drawScope(state, centerX, centerY, radius) {
    const { ctx } = this;
    const time = state.visualClock;
    const activePulse = state.pulses[state.pulses.length - 1];

    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, TAU);
    ctx.clip();

    const scopeGradient = ctx.createRadialGradient(
      centerX,
      centerY,
      8,
      centerX,
      centerY,
      radius,
    );
    scopeGradient.addColorStop(0, "rgba(13, 49, 51, 0.8)");
    scopeGradient.addColorStop(0.7, "rgba(6, 24, 27, 0.72)");
    scopeGradient.addColorStop(1, "rgba(2, 9, 11, 0.94)");
    ctx.fillStyle = scopeGradient;
    ctx.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);

    for (let ring = 1; ring <= 5; ring += 1) {
      ctx.beginPath();
      ctx.arc(centerX, centerY, (radius * ring) / 5, 0, TAU);
      ctx.strokeStyle = ring === 5 ? "rgba(96, 225, 207, 0.25)" : "rgba(105, 162, 158, 0.12)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(116, 166, 162, 0.42)";
      ctx.font = `8px ${MONO}`;
      ctx.fillText(`${ring * 4}`, centerX + 4, centerY - (radius * ring) / 5 + 1);
    }

    ctx.strokeStyle = "rgba(105, 162, 158, 0.12)";
    for (let spoke = 0; spoke < 12; spoke += 1) {
      const angle = (spoke / 12) * TAU;
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(
        centerX + Math.cos(angle) * radius,
        centerY + Math.sin(angle) * radius,
      );
      ctx.stroke();
    }

    this.drawFlowTexture(state, centerX, centerY, radius, time);

    for (const pulse of state.pulses) {
      const progress = pulse.age / pulse.maxAge;
      const pulseRadius = progress * radius;
      ctx.beginPath();
      ctx.arc(centerX, centerY, pulseRadius, 0, TAU);
      ctx.strokeStyle = `rgba(96, 225, 207, ${(1 - progress) * 0.42})`;
      ctx.lineWidth = progress < 0.1 ? 2.4 : 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(centerX, centerY, Math.max(0, pulseRadius - 5), 0, TAU);
      ctx.strokeStyle = `rgba(96, 225, 207, ${(1 - progress) * 0.12})`;
      ctx.stroke();
    }

    if (activePulse) {
      const currentRadius = (activePulse.age / activePulse.maxAge) * radius;
      const hits = state.echoes;
      for (const hit of hits) {
        const hitRadius = (hit.distance / MAX_RANGE) * radius;
        if (hitRadius > currentRadius + 3) continue;
        const alpha = clamp(0.24 + hit.intensity * 0.8, 0.1, 0.95) *
          clamp(1 - activePulse.age / activePulse.maxAge + 0.3, 0.32, 1);
        const material = MATERIALS[hit.materialKey] ?? MATERIALS.basalt;
        const color = hit.materialKey === "patrol" ? "#ef766f" : material.glow;
        const echoLength = 2.5 + hit.intensity * 8;
        ctx.strokeStyle = rgba(color, alpha);
        ctx.lineWidth = 1.1 + hit.intensity * 1.5;
        ctx.beginPath();
        ctx.arc(
          centerX,
          centerY,
          hitRadius,
          hit.angle - echoLength / Math.max(30, hitRadius),
          hit.angle + echoLength / Math.max(30, hitRadius),
        );
        ctx.stroke();
        if (hit.intensity > 0.72) {
          ctx.fillStyle = rgba(color, alpha * 0.65);
          ctx.beginPath();
          ctx.arc(
            centerX + Math.cos(hit.angle) * hitRadius,
            centerY + Math.sin(hit.angle) * hitRadius,
            1.2,
            0,
            TAU,
          );
          ctx.fill();
        }
      }
    }

    for (const ping of state.patrolPings) {
      const dx = ping.x - state.position.x;
      const dy = ping.y - state.position.y;
      const distance = Math.hypot(dx, dy);
      if (distance > MAX_RANGE) continue;
      const angle = Math.atan2(dy, dx);
      const pingRadius = (distance / MAX_RANGE) * radius;
      const life = 1 - ping.age / ping.maxAge;
      ctx.strokeStyle = `rgba(239, 118, 111, ${life * 0.55})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(
        centerX + Math.cos(angle) * pingRadius,
        centerY + Math.sin(angle) * pingRadius,
        5 + ping.age * 0.22,
        0,
        TAU,
      );
      ctx.stroke();
    }

    this.drawPlayer(centerX, centerY, state);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + 1, 0, TAU);
    ctx.strokeStyle = "rgba(96, 225, 207, 0.38)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "rgba(96, 225, 207, 0.68)";
    ctx.font = `8px ${MONO}`;
    ctx.fillText("NO CARTOGRAPHY / BEARING ONLY", centerX - radius, centerY + radius + 17);
  }

  drawFlowTexture(state, centerX, centerY, radius, time) {
    const { ctx } = this;
    const strength = state.current.strength;
    if (strength < 0.02) return;
    ctx.strokeStyle = `rgba(112, 183, 216, ${0.08 + strength * 0.13})`;
    ctx.lineWidth = 0.7;
    for (let line = 0; line < 14; line += 1) {
      const seed = (line * 71 + 19) % 360;
      const r = (seed / 360) * radius * 0.92;
      const angle = seed * 0.071 + time * 0.003 * (line % 2 ? 1 : -1);
      const x = centerX + Math.cos(angle) * r;
      const y = centerY + Math.sin(angle) * r;
      const length = 4 + strength * 12;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(
        x + state.current.vx * length,
        y + state.current.vy * length,
      );
      ctx.stroke();
    }
  }

  drawPlayer(centerX, centerY, state) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.strokeStyle = state.status === "FAILED" ? "#ef766f" : "#60e1cf";
    ctx.fillStyle = state.status === "FAILED" ? "rgba(239,118,111,0.16)" : "rgba(96,225,207,0.14)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.rotate(state.heading + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(7, 7);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fillStyle = state.status === "FAILED" ? "#ef766f" : "#8ff4e7";
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "rgba(182, 212, 207, 0.7)";
    ctx.font = `8px ${MONO}`;
    ctx.fillText("LISTENER", centerX + 14, centerY + 3);
  }

  drawTopReadout(state, x, y) {
    const { ctx } = this;
    const listening =
      state.status === "PAUSED"
        ? "FROZEN"
        : state.status === "READY"
          ? "STANDBY"
          : state.pulses.some((pulse) => pulse.age < 14)
            ? "ACTIVE PING"
            : "PASSIVE LISTEN";
    ctx.fillStyle = "rgba(96, 225, 207, 0.72)";
    ctx.font = `9px ${MONO}`;
    ctx.fillText(listening, x, y);
    ctx.fillStyle = "rgba(128, 160, 157, 0.55)";
    ctx.fillText(
      `EXPOSURE ${Math.round(state.exposure).toString().padStart(3, "0")} / ${MAX_EXPOSURE}`,
      x,
      y + 14,
    );
  }

  drawWavePanel(state, panel, audioState) {
    const { ctx } = this;
    const { x, y, width, height } = panel;
    const compact = width > 480;
    roundedRect(ctx, x, y, width, height, 12);
    ctx.fillStyle = "rgba(5, 18, 21, 0.72)";
    ctx.fill();
    ctx.strokeStyle = "rgba(111, 171, 170, 0.18)";
    ctx.stroke();

    const stateLabel =
      state.status === "PAUSED"
        ? "PAUSED"
        : state.status === "FAILED"
          ? "SIGNAL LOST"
          : state.status === "SUCCESS"
            ? "EXIT LOCKED"
            : state.status === "READY"
              ? "LISTENING OFFLINE"
              : "LISTENING";
    const active = state.status === "RUNNING";
    ctx.fillStyle = active ? "#8ff4e7" : state.status === "FAILED" ? "#ef766f" : "#75908d";
    ctx.font = `700 9px ${MONO}`;
    ctx.fillText(stateLabel, x + 16, y + 22);
    ctx.fillStyle = "rgba(121, 154, 151, 0.6)";
    ctx.font = `8px ${MONO}`;
    const audioLabel = audioState?.available
      ? audioState.muted
        ? "WEB AUDIO / MUTED"
        : "WEB AUDIO / SYNTH"
      : "WEB AUDIO / STANDBY";
    ctx.fillText(audioLabel, x + 16, y + 36);

    const waveTop = y + 46;
    const waveHeight = Math.max(26, Math.min(72, height * 0.49));
    const waveLeft = x + 15;
    const waveRight = x + width - 15;
    const center = waveTop + waveHeight / 2;
    ctx.strokeStyle = "rgba(112, 183, 216, 0.12)";
    ctx.beginPath();
    ctx.moveTo(waveLeft, center);
    ctx.lineTo(waveRight, center);
    ctx.stroke();
    ctx.beginPath();
    const phase = state.visualClock * 0.24;
    const running = state.status === "RUNNING";
    const amplitude = running
      ? 3 + Math.min(15, state.current.strength * 9) + Math.min(10, state.exposure * 0.09)
      : 0.7;
    for (let pixel = 0; pixel <= waveRight - waveLeft; pixel += 2) {
      const t = pixel / Math.max(1, waveRight - waveLeft);
      const carrier = Math.sin(t * 54 + phase) * 0.6;
      const harmonic = Math.sin(t * 19 - phase * 0.7) * 0.27;
      const grit = running
        ? Math.sin(t * 173 + phase * 2.1) * 0.09 * (state.exposure / MAX_EXPOSURE)
        : 0;
      const yValue = center + (carrier + harmonic + grit) * amplitude;
      if (pixel === 0) ctx.moveTo(waveLeft, yValue);
      else ctx.lineTo(waveLeft + pixel, yValue);
    }
    ctx.strokeStyle = running ? "rgba(112, 183, 216, 0.78)" : "rgba(112, 183, 216, 0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    const summary = state.lastScan?.materialSummary;
    const barTop = waveTop + waveHeight + 12;
    const barWidth = (waveRight - waveLeft) / 4;
    MATERIAL_LIST.forEach((material, index) => {
      const count = summary?.[material.key] ?? 0;
      const fraction = clamp(count / 32, 0, 1);
      const barX = waveLeft + index * barWidth;
      ctx.fillStyle = "rgba(102, 145, 142, 0.12)";
      ctx.fillRect(barX, barTop, barWidth - 7, 3);
      ctx.fillStyle = rgba(material.glow, 0.8);
      ctx.fillRect(barX, barTop, (barWidth - 7) * fraction, 3);
      ctx.fillStyle = "rgba(132, 164, 161, 0.66)";
      ctx.font = `7px ${SANS}`;
      ctx.fillText(material.name, barX, barTop + 15);
    });

    if (compact && height > 150) {
      const scan = state.lastScan;
      ctx.fillStyle = "rgba(155, 185, 181, 0.68)";
      ctx.font = `8px ${SANS}`;
      ctx.fillText(
        scan
          ? `最近回波 ${scan.count} 路 · ${state.pulses.length ? "波前传播中" : "已衰减"}`
          : "尚无回波：主动声呐等待发射",
        x + 16,
        y + height - 16,
      );
    }
  }

  drawCompass(state, centerX, y) {
    const { ctx } = this;
    const width = 190;
    const left = centerX - width / 2;
    ctx.strokeStyle = "rgba(133, 173, 169, 0.2)";
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + width, y);
    ctx.stroke();
    for (let tick = 0; tick <= 12; tick += 1) {
      const x = left + (tick / 12) * width;
      const tall = tick % 3 === 0;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + (tall ? 7 : 3));
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(133, 173, 169, 0.62)";
    ctx.font = `7px ${MONO}`;
    ctx.textAlign = "center";
    ctx.fillText("N", left + width * 0.25, y - 4);
    ctx.fillText("E", left + width * 0.5, y - 4);
    ctx.fillText("S", left + width * 0.75, y - 4);
    ctx.textAlign = "left";
  }

  drawTrueMap(game) {
    const state = game.state;
    const world = game.world;
    const { ctx, width, height } = this;
    const margin = 34;
    const scale = Math.min(
      (width - margin * 2) / WORLD_WIDTH,
      (height - margin * 2 - 52) / WORLD_HEIGHT,
    );
    const mapWidth = WORLD_WIDTH * scale;
    const mapHeight = WORLD_HEIGHT * scale;
    const originX = (width - mapWidth) / 2;
    const originY = margin + 30;

    ctx.fillStyle = "rgba(3, 11, 13, 0.68)";
    ctx.fillRect(originX - 8, originY - 8, mapWidth + 16, mapHeight + 16);
    for (let y = 0; y < WORLD_HEIGHT; y += 1) {
      for (let x = 0; x < WORLD_WIDTH; x += 1) {
        const tile = tileAt(world.grid, x, y);
        const px = originX + x * scale;
        const py = originY + y * scale;
        if (tile === 0) {
          ctx.fillStyle = "#08191d";
        } else if (tile === MATERIALS.gate.id) {
          ctx.fillStyle = "#d8ad51";
        } else {
          const material = materialForTile(tile);
          ctx.fillStyle = material.color;
        }
        ctx.fillRect(px, py, Math.ceil(scale) + 0.2, Math.ceil(scale) + 0.2);
      }
    }

    for (const current of world.currents) {
      const cx = originX + current.x * scale;
      const cy = originY + current.y * scale;
      ctx.fillStyle = "rgba(72, 143, 178, 0.12)";
      ctx.strokeStyle = "rgba(112, 183, 216, 0.3)";
      ctx.beginPath();
      ctx.arc(cx, cy, current.radius * scale, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "rgba(112, 183, 216, 0.62)";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(current.angle) * current.radius * scale * 0.8,
        cy + Math.sin(current.angle) * current.radius * scale * 0.8,
      );
      ctx.stroke();
      ctx.fillStyle = "rgba(146, 195, 213, 0.65)";
      ctx.font = `8px ${SANS}`;
      ctx.fillText(current.name, cx + 4, cy - 4);
    }

    if (state.trail.length > 1) {
      ctx.beginPath();
      state.trail.forEach((point, index) => {
        const px = originX + point.x * scale;
        const py = originY + point.y * scale;
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = "rgba(96, 225, 207, 0.55)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    for (const patrol of state.patrols) {
      const px = originX + patrol.x * scale;
      const py = originY + patrol.y * scale;
      ctx.fillStyle = rgba("#ef766f", patrol.alertTicks > 0 ? 0.75 : 0.4);
      ctx.beginPath();
      ctx.arc(px, py, Math.max(3, scale * 0.38), 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(239, 118, 111, 0.4)";
      ctx.beginPath();
      ctx.arc(px, py, 7, 0, TAU);
      ctx.stroke();
    }

    for (const exit of world.exits) {
      const px = originX + (exit.x + 0.5) * scale;
      const py = originY + (exit.y + 0.5) * scale;
      const correct = exit.id === world.correctExitIndex;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(6, scale * 0.8), 0, TAU);
      ctx.fillStyle = correct ? "rgba(121, 213, 155, 0.22)" : "rgba(240, 189, 97, 0.14)";
      ctx.fill();
      ctx.strokeStyle = correct ? "#79d59b" : "#f0bd61";
      ctx.lineWidth = correct ? 2 : 1;
      ctx.stroke();
      ctx.fillStyle = correct ? "#9debb8" : "#ecd39c";
      ctx.font = `700 9px ${MONO}`;
      ctx.fillText(`${exit.id + 1}${correct ? " ✓" : ""}`, px + 9, py + 3);
    }

    const px = originX + state.position.x * scale;
    const py = originY + state.position.y * scale;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(state.heading + Math.PI / 2);
    ctx.fillStyle = "#8ff4e7";
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const title =
      state.outcome === "success"
        ? "测绘解封：正确出口已确认"
        : state.outcome === "failed"
          ? `测绘解封：${state.failureReason === "wrong_exit" ? "出口判断错误" : "本次下潜失败"}`
          : "真实洞穴测绘";
    ctx.fillStyle = "rgba(213, 233, 229, 0.92)";
    ctx.font = `500 15px ${SANS}`;
    ctx.fillText(title, margin, 28);
    ctx.fillStyle = "rgba(132, 165, 161, 0.7)";
    ctx.font = `9px ${MONO}`;
    ctx.fillText(
      `TRUE MAP / SEED ${world.seed} / FINAL HASH ${game.getHash().slice(0, 12)}`,
      margin,
      44,
    );
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(132, 165, 161, 0.72)";
    ctx.font = `9px ${SANS}`;
    ctx.fillText("绿圈 = 正确出口 · 红点 = 巡逻源 · 蓝圈 = 暗流", width - margin, 28);
    ctx.textAlign = "left";
  }
}
