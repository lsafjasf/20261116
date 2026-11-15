const COLORS = {
  waterTop: "#0a2d38",
  waterBottom: "#04141c",
  deck: "#17313a",
  deckLight: "#244952",
  line: "rgba(157, 204, 195, 0.18)",
  ink: "#eaf5f2",
  muted: "#87a5a1",
  mint: "#5de0bd",
  amber: "#ffc35e",
  coral: "#ff7b72",
  blue: "#7aa7ff",
};

export class HarborRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.width = 0;
    this.height = 0;
    this.startedAt = performance.now();
    this.lastState = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  reset() {
    this.startedAt = performance.now();
    this.lastState = null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    this.width = Math.max(280, rect.width);
    this.height = Math.max(360, rect.height);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  draw(game, ui = {}) {
    if (!game || !this.width || !this.height) return;
    const context = this.context;
    const time = (performance.now() - this.startedAt) / 1000;
    const state = game.state;
    context.clearRect(0, 0, this.width, this.height);
    this.drawSea(context, time, state);
    this.drawDock(context);
    this.drawConnections(context, time, state);
    this.drawShip(context, time, game, ui);
    this.drawStatus(context, state, ui);
  }

  drawSea(context, time, state) {
    const gradient = context.createLinearGradient(0, 0, 0, this.height);
    gradient.addColorStop(0, COLORS.waterTop);
    gradient.addColorStop(1, COLORS.waterBottom);
    context.fillStyle = gradient;
    context.fillRect(0, 0, this.width, this.height);

    context.save();
    context.globalAlpha = 0.13;
    context.strokeStyle = COLORS.mint;
    context.lineWidth = 1;
    for (let row = 0; row < 9; row += 1) {
      context.beginPath();
      const y = this.height * 0.42 + row * 28;
      for (let x = -20; x < this.width + 25; x += 12) {
        const wave = Math.sin(x * 0.018 + time * 0.85 + row * 0.6) * 3;
        if (x < 0) context.moveTo(x, y + wave);
        else context.lineTo(x, y + wave);
      }
      context.stroke();
    }
    context.restore();

    context.save();
    context.globalAlpha = 0.12;
    context.fillStyle = "#a9ddd3";
    for (let index = 0; index < 24; index += 1) {
      const x = ((index * 97 + 41) % 100 / 100) * this.width;
      const y = this.height * 0.36 + ((index * 53) % 100 / 100) * this.height * 0.6;
      const radius = index % 4 === 0 ? 1.4 : 0.7;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();

    if (state.status === "lost") {
      context.fillStyle = "rgba(255, 123, 114, 0.035)";
      context.fillRect(0, 0, this.width, this.height);
    } else if (state.status === "won") {
      const glow = context.createRadialGradient(
        this.width * 0.7,
        this.height * 0.48,
        10,
        this.width * 0.7,
        this.height * 0.48,
        this.width * 0.55,
      );
      glow.addColorStop(0, "rgba(93, 224, 189, 0.13)");
      glow.addColorStop(1, "rgba(93, 224, 189, 0)");
      context.fillStyle = glow;
      context.fillRect(0, 0, this.width, this.height);
    }
  }

  drawDock(context) {
    const dockWidth = Math.max(58, this.width * 0.11);
    const top = this.height * 0.2;
    context.fillStyle = "rgba(10, 39, 48, 0.9)";
    context.fillRect(0, top, dockWidth, this.height - top);
    context.strokeStyle = COLORS.line;
    context.beginPath();
    context.moveTo(dockWidth, top);
    context.lineTo(dockWidth, this.height);
    context.stroke();

    for (let y = top + 36; y < this.height - 20; y += 48) {
      context.fillStyle = "rgba(122, 167, 255, 0.16)";
      context.fillRect(dockWidth - 18, y, 7, 2);
      context.fillStyle = "rgba(255, 255, 255, 0.08)";
      context.fillRect(14, y, dockWidth - 44, 1);
    }

    context.save();
    context.translate(dockWidth * 0.5, top + 34);
    context.rotate(-Math.PI / 2);
    context.fillStyle = "rgba(157, 204, 195, 0.42)";
    context.font = "600 9px 'Segoe UI', sans-serif";
    context.letterSpacing = "0.14em";
    context.fillText("BERTH 04 // GATE", 0, 3);
    context.restore();
  }

  drawConnections(context, time, state) {
    const startX = Math.max(64, this.width * 0.13);
    const firstY = this.height * 0.24;
    const secondY = this.height * 0.32;
    const endX = this.width * 0.53;
    const endY = this.height * 0.55;
    const active = state.activeRole;

    const drawPath = (y, role, color) => {
      context.save();
      context.strokeStyle = active === role ? color : "rgba(157, 204, 195, 0.09)";
      context.lineWidth = active === role ? 1.2 : 0.8;
      context.setLineDash(active === role ? [4, 5] : [2, 7]);
      context.lineDashOffset = -time * 12;
      context.beginPath();
      context.moveTo(startX, y);
      context.bezierCurveTo(startX + 55, y, endX - 90, endY - 30, endX, endY);
      context.stroke();
      context.restore();

      if (active === role && state.status === "responding") {
        const progress = (time * 0.35) % 1;
        const x = startX + (endX - startX) * progress;
        const yPos = y + (endY - y) * progress;
        context.fillStyle = color;
        context.beginPath();
        context.arc(x, yPos, 2.5, 0, Math.PI * 2);
        context.fill();
      }

      context.fillStyle = active === role ? color : "rgba(157, 204, 195, 0.32)";
      context.beginPath();
      context.arc(startX, y, 4, 0, Math.PI * 2);
      context.fill();
    };

    drawPath(firstY, "dispatcher", COLORS.amber);
    drawPath(secondY, "owner", COLORS.blue);
  }

  drawShip(context, time, game, ui) {
    const state = game.state;
    const dockEdge = Math.max(58, this.width * 0.11);
    const shipLeft = dockEdge + Math.max(22, this.width * 0.06);
    const shipRight = this.width - Math.max(18, this.width * 0.05);
    const deckY = this.height * 0.55;
    const deckHeight = Math.min(112, this.height * 0.23);
    const bob = Math.sin(time * 1.15) * 2;

    context.save();
    context.translate(0, bob);
    context.fillStyle = "rgba(0, 0, 0, 0.23)";
    context.beginPath();
    context.ellipse(
      (shipLeft + shipRight) / 2,
      deckY + deckHeight + 34,
      (shipRight - shipLeft) * 0.45,
      15,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();

    context.beginPath();
    context.moveTo(shipLeft + 18, deckY);
    context.lineTo(shipRight - 10, deckY);
    context.lineTo(shipRight - 42, deckY + deckHeight);
    context.quadraticCurveTo((shipLeft + shipRight) / 2, deckY + deckHeight + 28, shipLeft + 15, deckY + deckHeight);
    context.lineTo(shipLeft, deckY + 34);
    context.closePath();
    const hull = context.createLinearGradient(0, deckY, 0, deckY + deckHeight);
    hull.addColorStop(0, "#24444e");
    hull.addColorStop(1, "#112a33");
    context.fillStyle = hull;
    context.fill();
    context.strokeStyle = "rgba(157, 204, 195, 0.28)";
    context.lineWidth = 1;
    context.stroke();

    context.fillStyle = COLORS.deck;
    context.fillRect(shipLeft + 12, deckY - 13, shipRight - shipLeft - 30, 22);
    context.strokeStyle = "rgba(157, 204, 195, 0.18)";
    context.strokeRect(shipLeft + 12, deckY - 13, shipRight - shipLeft - 30, 22);

    context.fillStyle = "rgba(234, 245, 242, 0.22)";
    context.font = "600 8px 'Segoe UI', sans-serif";
    context.fillText("MV SHARED BERTH", shipLeft + 24, deckY + deckHeight * 0.58);
    context.fillStyle = "rgba(255, 195, 94, 0.52)";
    context.fillRect(shipRight - 59, deckY + 29, 18, 3);

    const slotGap = 8;
    const innerLeft = shipLeft + 27;
    const innerRight = shipRight - 33;
    const slotWidth = (innerRight - innerLeft - slotGap * 3) / 4;
    const slotHeight = Math.min(74, deckHeight * 0.55);
    const slotY = deckY - 59;

    state.cargos.forEach((cargo) => {
      if (!cargo.loaded) return;
      const index = cargo.loadedSlot - 1;
      const x = innerLeft + index * (slotWidth + slotGap);
      this.drawCargoBlock(context, x, slotY, slotWidth, slotHeight, cargo, time, false);
    });

    for (let index = 0; index < 4; index += 1) {
      const x = innerLeft + index * (slotWidth + slotGap);
      context.save();
      context.setLineDash([3, 4]);
      context.strokeStyle = "rgba(157, 204, 195, 0.19)";
      context.strokeRect(x, slotY, slotWidth, slotHeight);
      context.setLineDash([]);
      context.fillStyle = "rgba(157, 204, 195, 0.26)";
      context.font = "500 8px ui-monospace, monospace";
      context.fillText(`0${index + 1}`, x + 7, slotY + 13);
      context.restore();
    }

    const current = state.current;
    if (current) {
      const cargo = state.cargos.find((item) => item.id === current.cargoId);
      const index = state.loaded.length;
      const x = innerLeft + Math.min(index, 3) * (slotWidth + slotGap);
      const pulse = 0.45 + Math.sin(time * 5) * 0.18;
      this.drawCargoBlock(context, x, slotY, slotWidth, slotHeight, cargo, time, true, pulse);
      this.drawTimerArc(context, x + slotWidth / 2, slotY - 24, current, state.tick);
    }
    context.restore();
  }

  drawCargoBlock(context, x, y, width, height, cargo, time, ghost, pulse = 0.5) {
    if (!cargo) return;
    context.save();
    context.globalAlpha = ghost ? pulse : 1;
    context.fillStyle = cargo.tone;
    context.fillRect(x + 2, y + 7, width - 4, height - 7);
    context.fillStyle = "rgba(4, 21, 27, 0.26)";
    context.fillRect(x + 2, y + 7, width - 4, 12);
    context.strokeStyle = ghost ? "rgba(255,255,255,0.65)" : "rgba(255,255,255,0.2)";
    context.setLineDash(ghost ? [4, 3] : []);
    context.strokeRect(x + 2, y + 7, width - 4, height - 7);
    context.setLineDash([]);
    context.fillStyle = "#072028";
    context.font = "700 15px 'Palatino Linotype', serif";
    context.fillText(cargo.code, x + 9, y + 29);
    context.font = "600 7px 'Segoe UI', sans-serif";
    context.fillText(`P${cargo.rank}`, x + 9, y + height - 8);
    if (!ghost) {
      context.fillStyle = cargo.tone;
      context.globalAlpha = 0.18 + Math.sin(time * 2 + cargo.rank) * 0.04;
      context.fillRect(x - 3, y + height + 4, width + 6, 2);
    }
    context.restore();
  }

  drawTimerArc(context, x, y, current, tick) {
    const total = current.expiresAt - current.startedAt;
    const left = Math.max(0, current.expiresAt - tick);
    const ratio = Math.max(0, Math.min(1, left / total));
    context.save();
    context.strokeStyle = ratio < 0.25 ? COLORS.coral : COLORS.amber;
    context.lineWidth = 2.5;
    context.beginPath();
    context.arc(x, y, 11, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
    context.stroke();
    context.fillStyle = COLORS.ink;
    context.font = "600 8px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText(`${Math.ceil(left / 10)}s`, x, y + 3);
    context.restore();
  }

  drawStatus(context, state, ui) {
    const x = Math.max(76, this.width * 0.13);
    const y = this.height - 32;
    context.fillStyle = "rgba(4, 20, 27, 0.58)";
    context.fillRect(10, this.height - 54, Math.min(255, this.width - 20), 38);
    context.fillStyle = "rgba(157, 204, 195, 0.24)";
    context.fillRect(10, this.height - 54, 2, 38);
    context.fillStyle = COLORS.muted;
    context.font = "600 8px ui-monospace, monospace";
    context.fillText(`SEED ${state.seed}`, x, y - 9);
    context.fillStyle = state.status === "lost" ? COLORS.coral : COLORS.ink;
    context.font = "500 10px 'Segoe UI', sans-serif";
    const text =
      state.status === "responding" && state.current
        ? `REQUEST // ${state.current.cargoId.toUpperCase()} // COST ${state.current.cost}`
        : `${ui.phase ?? state.status.toUpperCase()} // ${state.loaded.length} OF 4 LOADED`;
    context.fillText(text, x, y + 4);
  }
}
