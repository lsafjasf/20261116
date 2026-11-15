import {
  ANCHORS,
  BASE,
  RESCUE_POINTS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  cliffXAt,
} from "./sim.js";

const TAU = Math.PI * 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mix(a, b, amount) {
  return a + (b - a) * amount;
}

function rgba(hex, alpha) {
  const value = hex.replace("#", "");
  const bigint = Number.parseInt(value, 16);
  const red = (bigint >> 16) & 255;
  const green = (bigint >> 8) & 255;
  const blue = bigint & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function drawPerson(ctx, x, y, scale, time, color, waving = false) {
  const wave = waving ? Math.sin(time * 2.4 + x * 0.01) * 0.32 : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(0, -25, 5, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -20);
  ctx.lineTo(0, 0);
  ctx.lineTo(-6, 12);
  ctx.moveTo(0, 0);
  ctx.lineTo(6, 12);
  ctx.moveTo(0, -15);
  ctx.lineTo(-9, -7);
  ctx.lineTo(-12, -13 + wave * 9);
  ctx.moveTo(0, -15);
  ctx.lineTo(10, -5);
  ctx.lineTo(13, -12 - wave * 8);
  ctx.stroke();
  ctx.restore();
}

function drawDangerLight(ctx, x, y, time, active) {
  const glow = active ? 0.45 + 0.25 * Math.sin(time * 5.2) : 0.12;
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, 28);
  gradient.addColorStop(0, rgba("#f0b65b", glow));
  gradient.addColorStop(1, rgba("#f0b65b", 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, 28, 0, TAU);
  ctx.fill();
}

export class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = WORLD_WIDTH;
    this.height = WORLD_HEIGHT;
    this.lastTime = 0;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    const ratio = clamp(window.devicePixelRatio || 1, 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.ratio = ratio;
  }

  draw(view, time, mode = "live") {
    const ctx = this.ctx;
    const scaleX = this.canvas.width / WORLD_WIDTH;
    const scaleY = this.canvas.height / WORLD_HEIGHT;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.drawSky(ctx, time);
    this.drawDistantPeaks(ctx);
    this.drawWind(ctx, view.wind || { pressure: 0.3, direction: 1 }, time);
    this.drawGorge(ctx);
    this.drawRightCliff(ctx, time);
    this.drawDock(ctx, time);
    this.drawPylons(ctx, view);
    this.drawRescuePoints(ctx, view, time);
    this.drawCables(ctx, view, time);
    this.drawBasket(ctx, view, time);
    this.drawWindDust(ctx, view.wind || { pressure: 0.3 }, time);
    this.drawTargetReticle(ctx, view, time);
    if (mode === "replay") {
      this.drawReplayStamp(ctx, time);
    }
  }

  drawSky(ctx, time) {
    const gradient = ctx.createLinearGradient(0, 0, 0, WORLD_HEIGHT);
    gradient.addColorStop(0, "#19272c");
    gradient.addColorStop(0.32, "#253037");
    gradient.addColorStop(0.64, "#3c3633");
    gradient.addColorStop(1, "#120f10");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    const sun = ctx.createRadialGradient(685, 180, 0, 685, 180, 300);
    sun.addColorStop(0, "rgba(232, 165, 93, 0.2)");
    sun.addColorStop(0.42, "rgba(207, 119, 71, 0.09)");
    sun.addColorStop(1, "rgba(140, 88, 60, 0)");
    ctx.fillStyle = sun;
    ctx.fillRect(250, 0, 700, 480);

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = "#b7cbc6";
    ctx.lineWidth = 1;
    for (let index = 0; index < 16; index += 1) {
      const y = 58 + index * 16 + Math.sin(time * 0.08 + index) * 3;
      ctx.beginPath();
      ctx.moveTo(90 + (index % 5) * 26, y);
      ctx.bezierCurveTo(
        260,
        y - 12,
        510,
        y + 20,
        760,
        y - 5,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  drawDistantPeaks(ctx) {
    const layers = [
      { color: "#182529", y: 252, amp: 56, shift: 0.5 },
      { color: "#121e22", y: 320, amp: 88, shift: 1.1 },
      { color: "#0b171b", y: 380, amp: 118, shift: 1.7 },
    ];
    for (const layer of layers) {
      ctx.fillStyle = layer.color;
      ctx.beginPath();
      ctx.moveTo(0, layer.y);
      for (let x = 0; x <= WORLD_WIDTH; x += 34) {
        const peak = Math.sin(x * 0.009 + layer.shift) * layer.amp +
          Math.sin(x * 0.021 + layer.shift * 2) * layer.amp * 0.34;
        ctx.lineTo(x, layer.y - Math.abs(peak));
      }
      ctx.lineTo(WORLD_WIDTH, WORLD_HEIGHT);
      ctx.lineTo(0, WORLD_HEIGHT);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawWind(ctx, wind, time) {
    const pressure = clamp(Number(wind.pressure) || 0, 0, 1);
    const direction = wind.direction < 0 ? -1 : 1;
    ctx.save();
    ctx.lineCap = "round";
    for (let index = 0; index < 34; index += 1) {
      const speed = 64 + (index % 7) * 19;
      const travel = (time * speed + index * 127) % 1120;
      const x = direction > 0 ? travel - 70 : WORLD_WIDTH + 70 - travel;
      const y = 54 + ((index * 79 + Math.sin(time * 0.55 + index) * 24) % 440);
      const length = 20 + (index % 5) * 20 + pressure * 24;
      const alpha = 0.08 + pressure * 0.2 + (index % 3) * 0.018;
      ctx.strokeStyle = `rgba(193, 225, 219, ${alpha})`;
      ctx.lineWidth = index % 4 === 0 ? 1.1 : 0.65;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(
        x - direction * length * 0.45,
        y + Math.sin(time + index) * 6,
        x - direction * length,
        y + 2,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  drawGorge(ctx) {
    const mist = ctx.createLinearGradient(0, 300, 0, 620);
    mist.addColorStop(0, "rgba(57, 73, 74, 0)");
    mist.addColorStop(0.54, "rgba(39, 55, 56, 0.34)");
    mist.addColorStop(1, "rgba(4, 9, 11, 0.93)");
    ctx.fillStyle = mist;
    ctx.fillRect(0, 270, WORLD_WIDTH, 350);

    ctx.save();
    ctx.globalAlpha = 0.22;
    for (let index = 0; index < 8; index += 1) {
      const y = 455 + index * 19;
      ctx.fillStyle = index % 2 ? "#60706f" : "#314344";
      ctx.beginPath();
      ctx.ellipse(
        360 + (index % 4) * 130,
        y,
        210 + index * 8,
        13,
        0,
        0,
        TAU,
      );
      ctx.fill();
    }
    ctx.restore();

    ctx.fillStyle = "rgba(2, 8, 9, 0.78)";
    ctx.beginPath();
    ctx.moveTo(0, 522);
    ctx.lineTo(160, 477);
    ctx.lineTo(270, 500);
    ctx.lineTo(420, 470);
    ctx.lineTo(580, 520);
    ctx.lineTo(730, 486);
    ctx.lineTo(890, 535);
    ctx.lineTo(1000, 510);
    ctx.lineTo(1000, 620);
    ctx.lineTo(0, 620);
    ctx.closePath();
    ctx.fill();
  }

  drawRightCliff(ctx, time) {
    const outline = [];
    for (let y = 72; y <= WORLD_HEIGHT; y += 13) {
      const face = cliffXAt(y) +
        Math.sin(y * 0.047) * 8 +
        Math.sin(y * 0.13 + 1.3) * 3.5;
      outline.push({ x: face, y });
    }
    const cliff = ctx.createLinearGradient(720, 0, 1000, 620);
    cliff.addColorStop(0, "#303633");
    cliff.addColorStop(0.32, "#282b28");
    cliff.addColorStop(0.7, "#181d1c");
    cliff.addColorStop(1, "#0b1112");
    ctx.fillStyle = cliff;
    ctx.beginPath();
    ctx.moveTo(outline[0].x, outline[0].y);
    for (const point of outline) ctx.lineTo(point.x, point.y);
    ctx.lineTo(WORLD_WIDTH, WORLD_HEIGHT);
    ctx.lineTo(WORLD_WIDTH, 72);
    ctx.closePath();
    ctx.fill();

    ctx.save();
    ctx.globalAlpha = 0.46;
    for (let index = 0; index < 26; index += 1) {
      const y = 104 + index * 20;
      const x = cliffXAt(y) + 30 + (index % 4) * 35;
      ctx.fillStyle = index % 3 === 0 ? "#3f4541" : "#161b1b";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 47 + (index % 5) * 15, y + 8);
      ctx.lineTo(x + 28, y + 28);
      ctx.lineTo(x + 7, y + 20);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(196, 213, 201, 0.12)";
    ctx.lineWidth = 1;
    for (let index = 0; index < 12; index += 1) {
      const y = 100 + index * 43;
      const x = cliffXAt(y) + 7;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(
        x + 26,
        y + 20,
        x + 12,
        y + 44,
        x + 42,
        y + 67,
      );
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.18 + Math.sin(time * 0.18) * 0.03;
    const fog = ctx.createLinearGradient(690, 0, 850, 0);
    fog.addColorStop(0, "rgba(181, 202, 194, 0)");
    fog.addColorStop(1, "rgba(181, 202, 194, 0.38)");
    ctx.fillStyle = fog;
    ctx.fillRect(690, 65, 170, 555);
    ctx.restore();
  }

  drawDock(ctx, time) {
    ctx.save();
    ctx.fillStyle = "#10191a";
    ctx.beginPath();
    ctx.moveTo(96, 452);
    ctx.lineTo(398, 452);
    ctx.lineTo(426, 490);
    ctx.lineTo(116, 490);
    ctx.closePath();
    ctx.fill();

    const deck = ctx.createLinearGradient(0, 449, 0, 466);
    deck.addColorStop(0, "#4d5b58");
    deck.addColorStop(1, "#1e2a2a");
    ctx.fillStyle = deck;
    ctx.fillRect(111, 447, 298, 10);
    ctx.fillStyle = "rgba(104, 216, 196, 0.38)";
    ctx.fillRect(116, 456, 288, 2);

    ctx.strokeStyle = "#344542";
    ctx.lineWidth = 2;
    for (let x = 128; x < 398; x += 22) {
      ctx.beginPath();
      ctx.moveTo(x, 458);
      ctx.lineTo(x + 25, 488);
      ctx.stroke();
    }
    ctx.strokeStyle = "#596560";
    ctx.lineWidth = 1;
    for (let x = 128; x < 398; x += 44) {
      ctx.beginPath();
      ctx.moveTo(x, 468);
      ctx.lineTo(x + 15, 468);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(240, 182, 91, 0.7)";
    const blink = 0.55 + Math.sin(time * 3.7) * 0.3;
    ctx.globalAlpha = blink;
    ctx.beginPath();
    ctx.arc(365, 440, 2.6, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = "rgba(5, 12, 13, 0.7)";
    ctx.fillRect(111, 488, 310, 7);
    ctx.restore();
  }

  drawPylons(ctx, view) {
    for (const side of ["left", "right"]) {
      const anchor = ANCHORS[side];
      const cable = side === "left" ? view.leftTension : view.rightTension;
      const color = side === "left" ? "#68d8c4" : "#f0b65b";
      ctx.save();
      ctx.strokeStyle = "#465551";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(anchor.x - 12, 455);
      ctx.lineTo(anchor.x, anchor.y + 4);
      ctx.lineTo(anchor.x + 12, 455);
      ctx.stroke();

      ctx.strokeStyle = "#2a3837";
      ctx.lineWidth = 2;
      for (let y = anchor.y + 34; y < 448; y += 28) {
        ctx.beginPath();
        ctx.moveTo(anchor.x - ((y - anchor.y) / 373) * 12, y);
        ctx.lineTo(anchor.x + ((y - anchor.y) / 373) * 12, y + 28);
        ctx.moveTo(anchor.x + ((y - anchor.y) / 373) * 12, y);
        ctx.lineTo(anchor.x - ((y - anchor.y) / 373) * 12, y + 28);
        ctx.stroke();
      }

      ctx.fillStyle = "#1b2625";
      ctx.strokeStyle = "#64716d";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 12, 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 7 + cable * 0.025, 0, TAU);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.fillRect(anchor.x - 4, anchor.y + 19, 8, 2);
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  drawRescuePoints(ctx, view, time) {
    const points = view.points || [];
    RESCUE_POINTS.forEach((point, index) => {
      const state = points[index] || "waiting";
      const wall = cliffXAt(point.y);
      const ledgeEnd = point.x + 54;
      const active = state === "active" || state === "carried";
      drawDangerLight(ctx, ledgeEnd + 24, point.y - 14, time, active);

      const rock = ctx.createLinearGradient(ledgeEnd, point.y, wall, point.y);
      rock.addColorStop(0, "#404743");
      rock.addColorStop(0.45, "#2a302d");
      rock.addColorStop(1, "#171c1b");
      ctx.fillStyle = rock;
      ctx.beginPath();
      ctx.moveTo(wall + 8, point.y - 20);
      ctx.lineTo(ledgeEnd + 15, point.y - 8);
      ctx.lineTo(ledgeEnd, point.y + 4);
      ctx.lineTo(ledgeEnd + 20, point.y + 17);
      ctx.lineTo(wall + 6, point.y + 29);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(196, 210, 201, 0.17)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ledgeEnd + 3, point.y + 2);
      ctx.lineTo(wall - 3, point.y - 2);
      ctx.stroke();

      ctx.fillStyle = active ? "#f0b65b" : "#8d958e";
      ctx.globalAlpha = active ? 0.9 : 0.45;
      ctx.fillRect(ledgeEnd - 1, point.y - 12, 1.4, 12);
      ctx.beginPath();
      ctx.arc(ledgeEnd - 0.3, point.y - 13, 2.1, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (state !== "rescued") {
        drawPerson(
          ctx,
          ledgeEnd + 18,
          point.y - 1,
          state === "carried" ? 0.82 : 0.92,
          time + index,
          active ? "#d7c3a5" : "#8b948c",
          active,
        );
      } else {
        ctx.strokeStyle = "rgba(141, 207, 134, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ledgeEnd + 18, point.y - 10, 6, 0, TAU);
        ctx.stroke();
      }

      ctx.fillStyle = active ? "rgba(240, 182, 91, 0.82)" : "rgba(126, 145, 139, 0.46)";
      ctx.font = "9px \"Cliff Sans\", SFMono-Regular, Consolas, monospace";
      ctx.textAlign = "right";
      ctx.fillText(`0${index + 1} ${point.name}`, point.x + 91, point.y + 25);
    });
  }

  drawCables(ctx, view, time) {
    const basketX = Number(view.x) || BASE.x;
    const basketY = Number(view.y) || BASE.y;
    const angle = Number(view.angle) || 0;
    for (const side of ["left", "right"]) {
      const anchor = ANCHORS[side];
      const tension = side === "left" ? view.leftTension : view.rightTension;
      const severed = side === "left"
        ? view.leftWinch === "severed"
        : view.rightWinch === "severed";
      const localX = side === "left" ? -35 : 35;
      const localY = -25;
      const pointX = basketX + localX * Math.cos(angle) - localY * Math.sin(angle);
      const pointY = basketY + localX * Math.sin(angle) + localY * Math.cos(angle);
      const color = side === "left" ? "#68d8c4" : "#f0b65b";
      const alpha = clamp(0.28 + Number(tension || 0) / 125, 0.28, 0.92);
      const sag = 22 - clamp(Number(tension || 0), 0, 100) * 0.12;

      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = rgba(color, alpha);
      ctx.lineWidth = 1.2 + clamp(Number(tension || 0), 0, 100) * 0.012;
      ctx.shadowColor = rgba(color, 0.42);
      ctx.shadowBlur = 5;
      ctx.beginPath();
      if (severed) {
        const dropX = mix(anchor.x, pointX, 0.44);
        const dropY = mix(anchor.y, pointY, 0.44);
        ctx.moveTo(anchor.x, anchor.y);
        ctx.quadraticCurveTo(
          mix(anchor.x, dropX, 0.55),
          mix(anchor.y, dropY, 0.55) + 18,
          dropX,
          dropY,
        );
        ctx.stroke();
        ctx.strokeStyle = rgba(color, 0.65);
        ctx.beginPath();
        ctx.moveTo(dropX, dropY);
        ctx.quadraticCurveTo(
          dropX + (side === "left" ? 9 : -9),
          dropY + 25,
          dropX + (side === "left" ? 4 : -4),
          dropY + 39,
        );
        ctx.stroke();
      } else {
        ctx.moveTo(anchor.x, anchor.y);
        ctx.quadraticCurveTo(
          mix(anchor.x, pointX, 0.5),
          mix(anchor.y, pointY, 0.5) + sag,
          pointX,
          pointY,
        );
        ctx.stroke();
      }
      ctx.restore();

      if (!severed) {
        const vibration = Math.sin(time * 19 + side.length) *
          clamp(Number(tension || 0) / 100, 0, 1) * 0.8;
        ctx.fillStyle = rgba(color, 0.7);
        ctx.beginPath();
        ctx.arc(pointX + vibration, pointY + 2, 2.2, 0, TAU);
        ctx.fill();
      }
    }
  }

  drawBasket(ctx, view, time) {
    const x = Number(view.x) || BASE.x;
    const y = Number(view.y) || BASE.y;
    const angle = Number(view.angle) || 0;
    const durability = Number(view.durability ?? 100);
    const carrying = !!view.carrying;
    const protection = view.protection?.active;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    if (!protection) {
      ctx.save();
      ctx.globalAlpha = 0.1 + Math.sin(time * 2.1) * 0.025;
      ctx.fillStyle = "#f0b65b";
      ctx.beginPath();
      ctx.ellipse(0, 31, 68, 15, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.strokeStyle = "#9ba5a0";
    ctx.lineWidth = 2;
    for (const side of [-35, 35]) {
      ctx.beginPath();
      ctx.moveTo(side, -25);
      ctx.lineTo(side * 0.82, -34);
      ctx.stroke();
      ctx.fillStyle = "#2c3836";
      ctx.strokeStyle = "#84908a";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(side, -27, 5, 0, TAU);
      ctx.fill();
      ctx.stroke();
    }

    const body = ctx.createLinearGradient(0, -28, 0, 28);
    body.addColorStop(0, "#5a6762");
    body.addColorStop(0.24, "#394642");
    body.addColorStop(1, "#1b2524");
    ctx.fillStyle = body;
    ctx.strokeStyle = durability < 45 ? "#dc8175" : "#7f8b85";
    ctx.lineWidth = 1.4;
    roundedRect(ctx, -42, -23, 84, 47, 7);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#172120";
    roundedRect(ctx, -36, -18, 72, 26, 3);
    ctx.fill();

    ctx.strokeStyle = "#78847d";
    ctx.lineWidth = 1.2;
    for (let rail = -31; rail <= 31; rail += 9) {
      ctx.beginPath();
      ctx.moveTo(rail, -22);
      ctx.lineTo(rail, -9);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-42, -10);
    ctx.lineTo(42, -10);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(-42, -23, 84, 47);
    ctx.clip();
    ctx.strokeStyle = "rgba(240, 182, 91, 0.28)";
    ctx.lineWidth = 6;
    for (let stripe = -58; stripe < 70; stripe += 24) {
      ctx.beginPath();
      ctx.moveTo(stripe, 25);
      ctx.lineTo(stripe + 16, 8);
      ctx.stroke();
    }
    ctx.restore();

    if (carrying) {
      ctx.save();
      ctx.translate(0, 2);
      ctx.rotate(-0.08);
      drawPerson(ctx, 4, 6, 0.72, time + 2, "#d9bb96", false);
      ctx.strokeStyle = "#d9bb96";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-5, 5);
      ctx.lineTo(-20, 1);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = "#78847d";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 8, 5, 0, TAU);
      ctx.moveTo(0, 13);
      ctx.lineTo(0, 20);
      ctx.stroke();
    }

    ctx.fillStyle = "#c9d5ce";
    ctx.globalAlpha = 0.55 + Math.sin(time * 3.4) * 0.12;
    ctx.beginPath();
    ctx.arc(-33, -6, 2.1, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (protection) {
      ctx.strokeStyle = "rgba(241, 111, 99, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, 55, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  drawTargetReticle(ctx, view, time) {
    if (view.carrying || view.phase === "complete" || view.phase === "failed") return;
    const index = Number(view.targetIndex) || 0;
    const point = RESCUE_POINTS[index];
    if (!point) return;
    const pulse = 0.5 + Math.sin(time * 2.2) * 0.18;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.strokeStyle = `rgba(104, 216, 196, ${pulse})`;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 7]);
    ctx.beginPath();
    ctx.arc(0, 0, 35 + Math.sin(time * 1.8) * 3, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = `rgba(104, 216, 196, ${pulse + 0.2})`;
    for (let index = 0; index < 4; index += 1) {
      ctx.save();
      ctx.rotate(index * Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -45);
      ctx.lineTo(-3, -51);
      ctx.moveTo(0, -45);
      ctx.lineTo(3, -51);
      ctx.stroke();
      ctx.restore();
    }

    const capture = clamp(Number(view.captureProgress) || 0, 0, 1);
    if (capture > 0) {
      ctx.strokeStyle = "#68d8c4";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, 39, -Math.PI / 2, -Math.PI / 2 + TAU * capture);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawWindDust(ctx, wind, time) {
    const pressure = clamp(Number(wind.pressure) || 0, 0, 1);
    const direction = wind.direction < 0 ? -1 : 1;
    ctx.save();
    for (let index = 0; index < 18; index += 1) {
      const travel = (time * (32 + index * 3) + index * 151) % 1100;
      const x = direction > 0 ? travel - 50 : WORLD_WIDTH + 50 - travel;
      const y = 470 + ((index * 29 + Math.sin(time * 0.9 + index) * 18) % 120);
      const alpha = 0.05 + pressure * 0.1;
      ctx.fillStyle = `rgba(214, 205, 183, ${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.7 + (index % 3) * 0.45, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawReplayStamp(ctx, time) {
    ctx.save();
    ctx.globalAlpha = 0.66;
    ctx.fillStyle = "rgba(6, 12, 14, 0.68)";
    ctx.fillRect(14, WORLD_HEIGHT - 46, 108, 26);
    ctx.strokeStyle = "rgba(104, 216, 196, 0.35)";
    ctx.strokeRect(14.5, WORLD_HEIGHT - 45.5, 107, 25);
    ctx.fillStyle = "#68d8c4";
    ctx.font = "9px \"Cliff Sans\", SFMono-Regular, Consolas, monospace";
    ctx.fillText("◼ REPLAY", 24, WORLD_HEIGHT - 29);
    ctx.fillStyle = "rgba(104, 216, 196, 0.55)";
    ctx.fillRect(86, WORLD_HEIGHT - 35, 26 * (0.7 + Math.sin(time * 3) * 0.2), 2);
    ctx.restore();
  }
}
