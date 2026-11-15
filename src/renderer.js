const TAU = Math.PI * 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function colorWithAlpha(hex, alpha) {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value, 16);
  const red = (number >> 16) & 255;
  const green = (number >> 8) & 255;
  const blue = number & 255;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export class FlightRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.width = 900;
    this.height = 470;
    this.dpr = 1;
    this.needsRedraw = true;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(320, rect.width);
    this.height = Math.max(330, rect.height);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.needsRedraw = true;
  }

  draw(frame, options = {}) {
    if (!frame) return;
    const ctx = this.context;
    const width = this.width;
    const height = this.height;
    ctx.clearRect(0, 0, width, height);
    this.drawSky(frame, width, height);
    this.drawClouds(frame, width, height);
    this.drawGround(frame, width, height);
    this.drawAircraft(frame, width, height);
    this.drawAttitude(frame, width * 0.5, Math.min(105, height * 0.23), Math.min(49, width * 0.06));
    this.drawRpmInstrument(frame, 68, 122, 40);
    this.drawPressureInstrument(frame, width - 68, 122, 40);
    this.drawEngineDetail(frame, 62, height - 78, Math.min(80, width * 0.1));
    this.drawHydraulicDetail(frame, width - 68, height - 77, Math.min(88, width * 0.11));
    this.drawFrameHud(frame, width, height, options);
    if (options.conflict) this.drawConflictMarker(options.conflict, frame, width, height);
    else this.drawCollisionMarker(frame, width, height);
    if (options.replay) this.drawReplayStamp(frame, width, height);
    this.needsRedraw = false;
  }

  drawSky(frame, width, height) {
    const ctx = this.context;
    const altitudeFactor = clamp(frame.altitude / 420, 0, 1);
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#07121c");
    gradient.addColorStop(0.38, `hsl(${205 - altitudeFactor * 7} 42% ${18 + altitudeFactor * 17}%)`);
    gradient.addColorStop(0.76, `hsl(${193 + altitudeFactor * 5} 35% ${35 + altitudeFactor * 16}%)`);
    gradient.addColorStop(1, "#a7b2a5");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const glow = ctx.createRadialGradient(width * 0.7, height * 0.2, 4, width * 0.7, height * 0.2, width * 0.42);
    glow.addColorStop(0, "rgba(255, 229, 181, 0.22)");
    glow.addColorStop(0.25, "rgba(255, 203, 130, 0.08)");
    glow.addColorStop(1, "rgba(255, 203, 130, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(211, 232, 230, 0.045)";
    ctx.lineWidth = 1;
    for (let index = 1; index < 7; index += 1) {
      const y = (height / 7) * index;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  drawClouds(frame, width, height) {
    const ctx = this.context;
    const drift = (frame.x * 0.012 + frame.t * 1.8) % (width + 260);
    const clouds = [
      { x: 70, y: 0.35, size: 1.15, alpha: 0.06 },
      { x: 0.34, y: 0.28, size: 0.75, alpha: 0.045 },
      { x: 0.72, y: 0.46, size: 1.3, alpha: 0.075 },
      { x: 0.92, y: 0.33, size: 0.55, alpha: 0.04 }
    ];
    ctx.save();
    for (let index = 0; index < clouds.length; index += 1) {
      const cloud = clouds[index];
      const x = ((cloud.x * width - drift * (0.24 + index * 0.05)) % (width + 300)) - 100;
      const y = cloud.y * height;
      const size = 52 * cloud.size;
      const local = ctx.createRadialGradient(x, y, 1, x, y, size * 2.4);
      local.addColorStop(0, `rgba(230, 240, 235, ${cloud.alpha})`);
      local.addColorStop(0.5, `rgba(218, 230, 226, ${cloud.alpha * 0.58})`);
      local.addColorStop(1, "rgba(218, 230, 226, 0)");
      ctx.fillStyle = local;
      ctx.beginPath();
      ctx.ellipse(x, y, size * 2.2, size * 0.72, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawGround(frame, width, height) {
    const ctx = this.context;
    const groundY = height * 0.72 + clamp(frame.altitude * 0.34, 0, height * 0.19);
    const gradient = ctx.createLinearGradient(0, groundY, 0, height);
    gradient.addColorStop(0, "#303d36");
    gradient.addColorStop(0.18, "#26332d");
    gradient.addColorStop(1, "#101a17");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, groundY, width, height - groundY);

    ctx.strokeStyle = "rgba(211, 224, 201, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, groundY + 0.5);
    ctx.lineTo(width, groundY + 0.5);
    ctx.stroke();

    const runwayNear = frame.x < 1800;
    if (runwayNear) {
      const center = width * 0.5;
      const spread = clamp(180 + frame.x * 0.05, 150, 340);
      ctx.fillStyle = "rgba(21, 27, 25, 0.88)";
      ctx.beginPath();
      ctx.moveTo(center - 18, groundY + 3);
      ctx.lineTo(center + 18, groundY + 3);
      ctx.lineTo(center + spread, height);
      ctx.lineTo(center - spread, height);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(232, 225, 190, 0.5)";
      ctx.lineWidth = 2;
      ctx.setLineDash([18, 24]);
      ctx.beginPath();
      ctx.moveTo(center, groundY + 9);
      ctx.lineTo(center, height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(232, 225, 190, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(center - spread, height);
      ctx.lineTo(center - 18, groundY + 3);
      ctx.moveTo(center + spread, height);
      ctx.lineTo(center + 18, groundY + 3);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(10, 21, 18, 0.68)";
    const horizonOffset = (frame.x * 0.02) % 180;
    for (let index = -2; index < 10; index += 1) {
      const x = index * 180 - horizonOffset;
      const hill = Math.sin(index * 1.48 + 0.6) * 15;
      ctx.beginPath();
      ctx.moveTo(x, groundY);
      ctx.lineTo(x + 48, groundY - 14 - hill);
      ctx.lineTo(x + 82, groundY - 7);
      ctx.lineTo(x + 128, groundY - 18 + hill * 0.4);
      ctx.lineTo(x + 180, groundY);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawAircraft(frame, width, height) {
    const ctx = this.context;
    const scale = clamp(Math.min(width / 760, height / 430), 0.64, 1.15);
    const planeX = width * 0.5;
    const planeY = height * 0.55 - clamp(frame.altitude * 0.09, 0, 40);
    const gearExtension = clamp(frame.right.gearPosition, 0, 1);
    const gearDrop = 58 * scale * gearExtension;
    const nuisance = frame.stage === "FAILED" ? Math.sin(frame.t * 19) * 0.7 : 0;

    ctx.save();
    ctx.translate(planeX, planeY + nuisance);
    ctx.rotate((frame.pitch * Math.PI) / 360);
    ctx.scale(scale, scale);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(2, 68, 174, 10, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    const bodyGradient = ctx.createLinearGradient(0, -30, 0, 38);
    bodyGradient.addColorStop(0, "#dfe8e3");
    bodyGradient.addColorStop(0.42, "#aebcc0");
    bodyGradient.addColorStop(0.66, "#758991");
    bodyGradient.addColorStop(1, "#26343a");
    ctx.fillStyle = bodyGradient;
    ctx.strokeStyle = "rgba(238, 247, 242, 0.45)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-156, -7);
    ctx.quadraticCurveTo(-178, -19, -192, -40);
    ctx.lineTo(-158, -37);
    ctx.quadraticCurveTo(-135, -31, -117, -13);
    ctx.lineTo(102, -19);
    ctx.quadraticCurveTo(145, -17, 172, -1);
    ctx.quadraticCurveTo(183, 8, 163, 15);
    ctx.lineTo(54, 25);
    ctx.quadraticCurveTo(20, 30, -35, 27);
    ctx.lineTo(-126, 15);
    ctx.quadraticCurveTo(-153, 7, -156, -7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#2c3d45";
    ctx.beginPath();
    ctx.moveTo(-86, -3);
    ctx.lineTo(-30, -69);
    ctx.lineTo(56, -62);
    ctx.lineTo(90, -4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(224, 235, 230, 0.2)";
    ctx.stroke();

    ctx.fillStyle = "rgba(180, 197, 199, 0.9)";
    ctx.beginPath();
    ctx.moveTo(-106, 0);
    ctx.lineTo(42, -8);
    ctx.lineTo(94, 20);
    ctx.lineTo(-55, 28);
    ctx.lineTo(-126, 8);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(245, 249, 240, 0.28)";
    ctx.stroke();

    ctx.fillStyle = "#526a72";
    ctx.beginPath();
    ctx.moveTo(-60, 16);
    ctx.lineTo(12, 18);
    ctx.lineTo(49, 52);
    ctx.lineTo(13, 55);
    ctx.lineTo(-38, 25);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#1b2a31";
    ctx.beginPath();
    ctx.ellipse(61, 35, 39, 17, -0.03, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(225, 240, 234, 0.25)";
    ctx.stroke();

    const fanGlow = clamp(frame.left.rpm / 3400, 0, 1);
    ctx.save();
    ctx.translate(94, 34);
    ctx.rotate(frame.t * (2 + fanGlow * 20));
    ctx.fillStyle = `rgba(255, 191, 93, ${0.18 + fanGlow * 0.5})`;
    for (let blade = 0; blade < 7; blade += 1) {
      const angle = (blade / 7) * TAU;
      ctx.beginPath();
      ctx.ellipse(Math.cos(angle) * 7, Math.sin(angle) * 7, 2.5, 10, angle, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = "#b6c8c7";
    ctx.beginPath();
    ctx.arc(0, 0, 5.4, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "#d7e0dc";
    ctx.fillStyle = "#152127";
    ctx.lineWidth = 4;
    const gearPoints = [
      { x: 77, length: 58, nose: true },
      { x: -20, length: 64, nose: false }
    ];
    for (const gear of gearPoints) {
      if (gearExtension < 0.06) continue;
      const wheelY = 27 + gearDrop * (gear.nose ? 0.96 : 1);
      ctx.beginPath();
      ctx.moveTo(gear.x, 23);
      ctx.lineTo(gear.x - 4 * gearExtension, wheelY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(gear.x - 4 * gearExtension, wheelY + 2, 7.4, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = "rgba(180, 198, 196, 0.45)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = "#d7e0dc";
      ctx.lineWidth = 4;
    }

    ctx.fillStyle = "#18252b";
    ctx.beginPath();
    ctx.ellipse(127, -8, 22, 7, -0.12, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 196, 109, 0.5)";
    ctx.lineWidth = 1;
    ctx.stroke();

    if (frame.stage === "FAILED") {
      ctx.fillStyle = "rgba(28, 27, 24, 0.55)";
      for (let puff = 0; puff < 3; puff += 1) {
        const t = (frame.t * 0.7 + puff * 0.33) % 1;
        ctx.beginPath();
        ctx.arc(-12 + t * 12, 28 - t * 38, 7 + t * 14, 0, TAU);
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(255, 152, 66, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-18, 48);
      ctx.lineTo(-31, 34);
      ctx.moveTo(-10, 49);
      ctx.lineTo(-2, 31);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawGauge(cx, cy, radius, fraction, color, label, valueText) {
    const ctx = this.context;
    const start = Math.PI * 0.75;
    const sweep = Math.PI * 1.5;
    ctx.save();
    ctx.translate(cx, cy);

    const glass = ctx.createRadialGradient(-radius * 0.35, -radius * 0.4, 3, 0, 0, radius);
    glass.addColorStop(0, "rgba(46, 60, 64, 0.96)");
    glass.addColorStop(0.72, "rgba(13, 22, 26, 0.96)");
    glass.addColorStop(1, "rgba(5, 9, 11, 0.97)");
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(203, 221, 218, 0.26)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.11)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 7, start, start + sweep);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.shadowColor = colorWithAlpha(color, 0.58);
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 7, start, start + sweep * clamp(fraction, 0, 1));
    ctx.stroke();
    ctx.shadowBlur = 0;

    for (let index = 0; index <= 10; index += 1) {
      const angle = start + (index / 10) * sweep;
      const inner = radius - (index % 5 === 0 ? 16 : 12);
      ctx.strokeStyle = index % 5 === 0 ? "rgba(235, 243, 240, 0.72)" : "rgba(235, 243, 240, 0.3)";
      ctx.lineWidth = index % 5 === 0 ? 1.2 : 0.6;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      ctx.lineTo(Math.cos(angle) * (radius - 7), Math.sin(angle) * (radius - 7));
      ctx.stroke();
    }

    const needleAngle = start + sweep * clamp(fraction, 0, 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(Math.cos(needleAngle) * 6, Math.sin(needleAngle) * 6);
    ctx.lineTo(Math.cos(needleAngle) * (radius - 16), Math.sin(needleAngle) * (radius - 16));
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, TAU);
    ctx.fill();

    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(220, 232, 229, 0.66)";
    ctx.font = "600 7px Bahnschrift, sans-serif";
    ctx.fillText(label, 0, radius * 0.5);
    ctx.fillStyle = "#eef5f1";
    ctx.font = `500 ${Math.max(10, radius * 0.27)}px Bahnschrift, monospace`;
    ctx.fillText(valueText, 0, radius * 0.74);
    ctx.restore();
  }

  drawRpmInstrument(frame, cx, cy, radius) {
    this.drawGauge(
      cx,
      cy,
      radius,
      frame.left.rpm / 3400,
      "#ffb84d",
      "N1 RPM",
      Math.round(frame.left.rpm).toString()
    );
  }

  drawPressureInstrument(frame, cx, cy, radius) {
    this.drawGauge(
      cx,
      cy,
      radius,
      frame.right.pressure / 100,
      "#53e0c1",
      "HYD BAR",
      Math.round(frame.right.pressure).toString()
    );
  }

  drawAttitude(frame, cx, cy, radius) {
    const ctx = this.context;
    const pitch = frame.pitch || 0;
    const roll = (frame.roll * Math.PI) / 180;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.clip();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-roll);
    const horizon = clamp(pitch * radius * 0.035, -radius * 0.75, radius * 0.75);
    ctx.fillStyle = "#3d879f";
    ctx.fillRect(-radius * 2, -radius * 2 + horizon, radius * 4, radius * 2);
    ctx.fillStyle = "#6c6246";
    ctx.fillRect(-radius * 2, horizon, radius * 4, radius * 2);
    ctx.strokeStyle = "rgba(240, 245, 235, 0.9)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-radius, horizon);
    ctx.lineTo(radius, horizon);
    ctx.stroke();

    ctx.strokeStyle = "rgba(246, 248, 237, 0.7)";
    ctx.fillStyle = "rgba(241, 247, 239, 0.8)";
    ctx.font = "7px Bahnschrift, sans-serif";
    ctx.textAlign = "center";
    for (let line = -3; line <= 3; line += 1) {
      if (line === 0) continue;
      const y = horizon - line * radius * 0.2;
      const half = Math.abs(line) === 1 ? 13 : 8;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(-half, y);
      ctx.lineTo(half, y);
      ctx.stroke();
      if (line % 2 === 0) ctx.fillText(Math.abs(line * 5).toString(), half + 7, y + 2);
    }
    ctx.restore();

    ctx.strokeStyle = "rgba(255, 209, 122, 0.95)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - 17, cy);
    ctx.lineTo(cx - 5, cy);
    ctx.moveTo(cx + 5, cy);
    ctx.lineTo(cx + 17, cy);
    ctx.stroke();
    ctx.fillStyle = "#ffd17a";
    ctx.beginPath();
    ctx.arc(cx, cy, 1.8, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "rgba(218, 234, 230, 0.62)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = "rgba(218, 234, 230, 0.25)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 3, Math.PI * 1.12, Math.PI * 1.88);
    ctx.stroke();
    for (const angle of [-0.5, 0, 0.5]) {
      const tickAngle = -Math.PI / 2 + angle;
      ctx.strokeStyle = "rgba(218, 234, 230, 0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(tickAngle) * (radius - 2), cy + Math.sin(tickAngle) * (radius - 2));
      ctx.lineTo(cx + Math.cos(tickAngle) * radius, cy + Math.sin(tickAngle) * radius);
      ctx.stroke();
    }
  }

  drawEngineDetail(frame, cx, cy, radius) {
    const ctx = this.context;
    const rpm = clamp(frame.left.rpm / 3400, 0, 1);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "rgba(7, 12, 14, 0.65)";
    ctx.strokeStyle = "rgba(255, 184, 77, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-radius * 0.95, -radius * 0.55, radius * 1.9, radius * 1.35, 8);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 205, 137, 0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(-radius * 0.4, 0, radius * 0.3, radius * 0.25, 0, 0, TAU);
    ctx.stroke();

    ctx.save();
    ctx.translate(-radius * 0.4, 0);
    ctx.rotate(frame.t * (0.4 + rpm * 18));
    for (let blade = 0; blade < 9; blade += 1) {
      const angle = (blade / 9) * TAU;
      ctx.strokeStyle = `rgba(224, 235, 229, ${0.25 + rpm * 0.55})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * 3, Math.sin(angle) * 3);
      ctx.lineTo(Math.cos(angle) * radius * 0.22, Math.sin(angle) * radius * 0.22);
      ctx.stroke();
    }
    ctx.restore();

    const heat = clamp((frame.left.temperature - 70) / 70, 0, 1);
    const exhaust = ctx.createLinearGradient(radius * 0.1, 0, radius * 0.88, 0);
    exhaust.addColorStop(0, `rgba(255, 145, 47, ${0.12 + rpm * 0.42})`);
    exhaust.addColorStop(0.5, `rgba(255, 193, 87, ${0.05 + rpm * 0.24})`);
    exhaust.addColorStop(1, "rgba(255, 193, 87, 0)");
    ctx.fillStyle = exhaust;
    ctx.beginPath();
    ctx.moveTo(radius * 0.08, -radius * 0.2);
    ctx.quadraticCurveTo(radius * 0.55, -radius * 0.36 - heat * 7, radius * 0.9, -heat * 3);
    ctx.quadraticCurveTo(radius * 0.58, radius * 0.33 + heat * 7, radius * 0.08, radius * 0.2);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "rgba(224, 235, 229, 0.65)";
    ctx.font = "600 6px Bahnschrift, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("FAN / COMBUSTOR", -radius * 0.9, -radius * 0.66);
    ctx.fillStyle = "rgba(255, 184, 77, 0.7)";
    ctx.fillText(`FPM ${Math.round(frame.left.fuelPump)}%`, radius * 0.2, -radius * 0.66);
    ctx.restore();
  }

  drawHydraulicDetail(frame, cx, cy, radius) {
    const ctx = this.context;
    const pressure = clamp(frame.right.pressure / 100, 0, 1);
    const gear = clamp(frame.right.gearPosition, 0, 1);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "rgba(7, 12, 14, 0.65)";
    ctx.strokeStyle = "rgba(83, 224, 193, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-radius * 0.95, -radius * 0.55, radius * 1.9, radius * 1.35, 8);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = "rgba(83, 224, 193, 0.25)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-radius * 0.7, radius * 0.23);
    ctx.lineTo(-radius * 0.2, radius * 0.23);
    ctx.lineTo(-radius * 0.2, -radius * 0.14);
    ctx.lineTo(radius * 0.07, -radius * 0.14);
    ctx.stroke();

    ctx.strokeStyle = `rgba(83, 224, 193, ${0.35 + pressure * 0.6})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(-radius * 0.7, radius * 0.23);
    ctx.lineTo(-radius * 0.7 + radius * 1.15 * pressure, radius * 0.23);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.translate(-radius * 0.48, radius * 0.22);
    ctx.rotate(frame.t * (0.4 + pressure * 8));
    for (let blade = 0; blade < 7; blade += 1) {
      const angle = (blade / 7) * TAU;
      ctx.strokeStyle = `rgba(134, 245, 221, ${0.25 + pressure * 0.55})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * radius * 0.17, Math.sin(angle) * radius * 0.17);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(83, 224, 193, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(-radius * 0.48, radius * 0.22, radius * 0.19, 0, TAU);
    ctx.stroke();

    const strutTopX = radius * 0.22;
    const strutTopY = -radius * 0.1;
    const strutAngle = (1 - gear) * 0.9;
    const strutLength = radius * (0.24 + gear * 0.3);
    const wheelX = strutTopX + Math.sin(strutAngle) * strutLength;
    const wheelY = strutTopY + Math.cos(strutAngle) * strutLength;
    ctx.strokeStyle = "rgba(205, 221, 219, 0.8)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(strutTopX, strutTopY);
    ctx.lineTo(wheelX, wheelY);
    ctx.stroke();
    ctx.fillStyle = "#152229";
    ctx.strokeStyle = `rgba(83, 224, 193, ${0.35 + gear * 0.5})`;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(wheelX, wheelY + 2, 4.8, 0, TAU);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(224, 235, 229, 0.65)";
    ctx.font = "600 6px Bahnschrift, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("PUMP / ACTUATOR", -radius * 0.9, -radius * 0.66);
    ctx.fillStyle = "rgba(83, 224, 193, 0.76)";
    ctx.fillText(`GEAR ${Math.round(gear * 100)}%`, radius * 0.08, -radius * 0.66);
    ctx.restore();
  }

  drawFrameHud(frame, width, height, options) {
    const ctx = this.context;
    ctx.save();
    ctx.font = "600 7px Bahnschrift, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255, 184, 77, 0.72)";
    ctx.fillText("ENGINE / LEFT", 18, height - 12);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(83, 224, 193, 0.72)";
    ctx.fillText("HYDRAULIC / RIGHT", width - 18, height - 12);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(224, 234, 230, 0.5)";
    ctx.fillText(
      `${options.replay ? "TIMELINE" : "LIVE"}  T+${frame.t.toFixed(2)}  ORDER ${(frame.order || "L-R").toUpperCase()}`,
      width * 0.5,
      height - 12
    );

    if (frame.shared?.crossDrag > 0.08) {
      const x = width * 0.5 - 40;
      const y = height - 31;
      ctx.fillStyle = "rgba(8, 13, 15, 0.72)";
      ctx.beginPath();
      ctx.roundRect(x, y - 10, 80, 13, 4);
      ctx.fill();
      ctx.fillStyle = "rgba(255, 184, 77, 0.82)";
      ctx.font = "600 7px Bahnschrift, sans-serif";
      ctx.fillText(`CROSS DRAG ${Math.round(frame.shared.crossDrag * 100)}%`, width * 0.5, y);
    }
    ctx.restore();
  }

  drawConflictMarker(conflict, frame, width, height) {
    if (!conflict || frame.t < conflict.t - 0.04) return;
    const ctx = this.context;
    const planeX = width * 0.5;
    const planeY = height * 0.55 - clamp(frame.altitude * 0.09, 0, 40);
    const targets = conflict.objects.map((object) => ({
      ...object,
      sx: planeX + (object.x - frame.x) * 0.86,
      sy: planeY - (object.y - frame.altitude) * 1.2
    }));
    ctx.save();
    ctx.strokeStyle = "rgba(255, 184, 77, 0.86)";
    ctx.fillStyle = "rgba(255, 184, 77, 0.9)";
    ctx.lineWidth = 1;
    for (const target of targets) {
      ctx.beginPath();
      ctx.arc(target.sx, target.sy, 9 + Math.sin(frame.t * 9) * 1.5, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(target.sx - 14, target.sy);
      ctx.lineTo(target.sx - 5, target.sy);
      ctx.moveTo(target.sx + 5, target.sy);
      ctx.lineTo(target.sx + 14, target.sy);
      ctx.moveTo(target.sx, target.sy - 14);
      ctx.lineTo(target.sx, target.sy - 5);
      ctx.moveTo(target.sx, target.sy + 5);
      ctx.lineTo(target.sx, target.sy + 14);
      ctx.stroke();
      ctx.font = "600 6px 'Noto Sans SC', Bahnschrift, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(target.id === "engine" ? "ENGINE" : "GEAR / HYD", target.sx, target.sy - 15);
    }
    if (targets.length > 1) {
      ctx.strokeStyle = "rgba(255, 184, 77, 0.46)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(targets[0].sx, targets[0].sy);
      ctx.lineTo(targets[1].sx, targets[1].sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "rgba(10, 12, 10, 0.84)";
    ctx.beginPath();
    ctx.roundRect(8, 42, 164, 30, 5);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 184, 77, 0.4)";
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 202, 122, 0.95)";
    ctx.font = "600 7px Bahnschrift, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(`ORDER CONFLICT T+${conflict.t.toFixed(2)}s`, 15, 53);
    ctx.fillStyle = "rgba(225, 231, 224, 0.74)";
    ctx.fillText(`X ${conflict.position.x.toFixed(1)}  ALT ${conflict.position.altitude.toFixed(1)}`, 15, 64);
    ctx.restore();
    this.drawCollisionMarker(frame, width, height);
  }

  drawCollisionMarker(frame, width, height) {
    if (!frame.collision || frame.t - frame.collision.t > 2.5) return;
    const ctx = this.context;
    const planeX = width * 0.5;
    const planeY = height * 0.55 - clamp(frame.altitude * 0.09, 0, 40);
    const x = planeX + (frame.collision.x - frame.x) * 0.86;
    const y = planeY - (frame.collision.y - frame.altitude) * 1.2 + 30;
    ctx.save();
    ctx.strokeStyle = "rgba(255, 92, 92, 0.95)";
    ctx.fillStyle = "rgba(255, 92, 92, 0.92)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 11, y - 11);
    ctx.lineTo(x + 11, y + 11);
    ctx.moveTo(x + 11, y - 11);
    ctx.lineTo(x - 11, y + 11);
    ctx.stroke();
    ctx.font = "600 7px Bahnschrift, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("COLLISION", x, y + 27);
    ctx.fillStyle = "rgba(255, 129, 129, 0.85)";
    ctx.font = "500 6px Bahnschrift, monospace";
    ctx.fillText(`${frame.collision.object} @ ${frame.collision.x.toFixed(1)}, ${frame.collision.y.toFixed(1)}`, x, y + 36);
    ctx.restore();
  }

  drawReplayStamp(frame, width, height) {
    const ctx = this.context;
    ctx.save();
    ctx.fillStyle = "rgba(4, 10, 12, 0.68)";
    ctx.beginPath();
    ctx.roundRect(width - 137, height - 44, 124, 27, 4);
    ctx.fill();
    ctx.strokeStyle = "rgba(83, 224, 193, 0.28)";
    ctx.stroke();
    ctx.fillStyle = "rgba(130, 237, 212, 0.88)";
    ctx.font = "600 7px Bahnschrift, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("REPLAY / READ-ONLY", width - 128, height - 33);
    ctx.fillStyle = "rgba(214, 231, 225, 0.58)";
    ctx.font = "500 6px Bahnschrift, monospace";
    ctx.fillText(`FRAME ${String(frame.tick).padStart(5, "0")}`, width - 128, height - 23);
    ctx.restore();
  }
}
