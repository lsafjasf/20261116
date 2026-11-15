const W = 1280;
const H = 640;
const COLORS = {
  bg: '#071116',
  panel: '#0b171c',
  steel: '#15252b',
  edge: '#2b3d42',
  grid: 'rgba(123, 160, 157, 0.055)',
  text: '#d9e3de',
  muted: '#6d8283',
  a: '#ffc45c',
  aDeep: '#c98121',
  b: '#64d8cb',
  bDeep: '#268c83',
  danger: '#ff665f',
  safe: '#7ee787',
};

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function label(ctx, text, x, y, options = {}) {
  ctx.save();
  ctx.font =
    options.font ??
    '600 10px "Twin Sort SC", "DIN Alternate", "Bahnschrift", sans-serif';
  ctx.fillStyle = options.color ?? COLORS.muted;
  ctx.textAlign = options.align ?? 'left';
  ctx.textBaseline = options.baseline ?? 'middle';
  if (options.letterSpacing) {
    const chars = [...text];
    const width = chars.reduce((sum, char) => sum + ctx.measureText(char).width, 0) +
      Math.max(0, chars.length - 1) * options.letterSpacing;
    let cursor = x;
    if (ctx.textAlign === 'center') cursor -= width / 2;
    if (ctx.textAlign === 'right') cursor -= width;
    ctx.textAlign = 'left';
    for (const char of chars) {
      ctx.fillText(char, cursor, y);
      cursor += ctx.measureText(char).width + options.letterSpacing;
    }
  } else {
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

export class SortRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * this.dpr;
    canvas.height = H * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this.particles = [];
  }

  background(ctx, now) {
    const gradient = ctx.createRadialGradient(640, 240, 20, 640, 320, 760);
    gradient.addColorStop(0, '#102329');
    gradient.addColorStop(0.45, '#0a171c');
    gradient.addColorStop(1, '#061015');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }
    for (let y = 0; y < H; y += 32) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.026)';
    for (let x = 12; x < W; x += 64) {
      ctx.fillRect(x, 58, 23, 2);
    }
    const pulse = 0.5 + Math.sin(now / 900) * 0.2;
    ctx.strokeStyle = `rgba(255,196,92,${0.08 + pulse * 0.05})`;
    ctx.strokeRect(16.5, 16.5, W - 33, H - 33);
  }

  floorStations(ctx, sim) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(20, 188, 118, 262);
    ctx.fillRect(1006, 142, 206, 386);
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(20.5, 188.5, 117, 261);
    ctx.strokeRect(1006.5, 142.5, 205, 385);
    ctx.setLineDash([]);
    label(ctx, 'INFEED / 上游', 28, 205, {
      font: '700 9px "SFMono-Regular", monospace',
      letterSpacing: 1.1,
    });
    label(ctx, 'BUFFER + PACK / 缓存与装箱', 1014, 159, {
      font: '700 9px "SFMono-Regular", monospace',
      letterSpacing: 1.1,
    });
    label(ctx, 'P1 · SCAN', 28, 430, {
      color: COLORS.a,
      font: '700 9px "SFMono-Regular", monospace',
    });
    label(ctx, 'P2 · ROUTE', 1211, 510, {
      color: COLORS.b,
      align: 'right',
      font: '700 9px "SFMono-Regular", monospace',
    });
    ctx.restore();
  }

  drawQueue(ctx, sim) {
    const queued = sim.packages
      .filter((pkg) => pkg.status === 'queue')
      .sort((a, b) => a.id - b.id);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,196,92,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(36, 410);
    ctx.lineTo(125, 410);
    ctx.stroke();
    for (let i = 0; i < Math.min(7, queued.length); i += 1) {
      const x = 42 + i * 11;
      const y = 398 - i * 2;
      this.drawPackage(ctx, queued[i], x, y, 30, 23, {
        dim: i > 0,
        label: i < 3,
      });
    }
    if (queued.length > 7) {
      label(ctx, `+${queued.length - 7}`, 76, 416, {
        color: COLORS.a,
        align: 'center',
        font: '700 10px "SFMono-Regular", monospace',
      });
    }
    label(ctx, `${queued.length} WAIT`, 28, 447, {
      color: queued.length > 8 ? COLORS.danger : COLORS.muted,
      font: '9px "SFMono-Regular", monospace',
    });
    ctx.restore();
  }

  drawScanner(ctx, sim, now) {
    const scanned = sim.scannedPackage();
    const pulse = 0.5 + Math.sin(now / 350) * 0.5;
    ctx.save();
    roundRect(ctx, 112, 270, 116, 112, 4);
    ctx.fillStyle = '#0b1a20';
    ctx.fill();
    ctx.strokeStyle = scanned ? COLORS.a : '#2c4145';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#15282e';
    ctx.fillRect(124, 282, 92, 9);
    ctx.fillStyle = scanned ? COLORS.a : '#3f5c60';
    ctx.fillRect(124, 282, scanned ? 92 : 40, 9);
    ctx.fillStyle = 'rgba(255,196,92,0.06)';
    ctx.fillRect(132, 299, 76, 49);
    ctx.strokeStyle = `rgba(255,196,92,${0.25 + pulse * 0.4})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(136, 309);
    ctx.lineTo(204, 309);
    ctx.moveTo(136, 326);
    ctx.lineTo(204, 326);
    ctx.moveTo(136, 343);
    ctx.lineTo(204, 343);
    ctx.stroke();
    if (scanned) {
      const scanY = 299 + ((now / 8) % 49);
      const beam = ctx.createLinearGradient(130, scanY, 210, scanY);
      beam.addColorStop(0, 'rgba(255,196,92,0)');
      beam.addColorStop(0.5, 'rgba(255,196,92,0.9)');
      beam.addColorStop(1, 'rgba(255,196,92,0)');
      ctx.strokeStyle = beam;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(130, scanY);
      ctx.lineTo(210, scanY);
      ctx.stroke();
    }
    label(ctx, 'SCANNER', 170, 365, {
      align: 'center',
      color: scanned ? COLORS.a : COLORS.muted,
      font: '700 8px "SFMono-Regular", monospace',
      letterSpacing: 1,
    });
    label(ctx, `${sim.durability.p1.toFixed(0)}%`, 213, 391, {
      align: 'right',
      color: sim.durability.p1 < 35 ? COLORS.danger : COLORS.muted,
      font: '9px "SFMono-Regular", monospace',
    });
    ctx.restore();
  }

  drawConveyor(ctx, sim, now) {
    ctx.save();
    const lineColor = sim.lineStop ? COLORS.danger : '#41575b';
    ctx.fillStyle = '#111f24';
    roundRect(ctx, 224, 286, 458, 56, 5);
    ctx.fill();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#0a1418';
    ctx.fillRect(232, 296, 440, 34);
    const offset = (sim.time * 34) % 27;
    for (let x = 232 - offset; x < 674; x += 27) {
      ctx.fillStyle = '#2a3b3f';
      ctx.fillRect(x, 297, 18, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(x + 3, 336, 12, 2);
    }
    for (let x = 250; x < 675; x += 48) {
      ctx.beginPath();
      ctx.arc(x, 314, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#18292e';
      ctx.fill();
      ctx.strokeStyle = '#354a4e';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 3, 311);
      ctx.lineTo(x + 3, 317);
      ctx.stroke();
    }
    ctx.strokeStyle = sim.lineStop ? 'rgba(255,102,95,0.32)' : 'rgba(255,196,92,0.22)';
    ctx.lineWidth = 1;
    for (let x = 244; x < 682; x += 34) {
      ctx.beginPath();
      ctx.moveTo(x, 350);
      ctx.lineTo(x + 16, 350);
      ctx.stroke();
    }
    label(ctx, sim.lineStop ? 'UPSTREAM HOLD' : 'BIDIRECTIONAL SORT DECK', 245, 369, {
      color: sim.lineStop ? COLORS.danger : COLORS.muted,
      font: '700 8px "SFMono-Regular", monospace',
      letterSpacing: 1.2,
    });
    const arrowShift = Math.sin(now / 300) * 2;
    label(ctx, '›››', 657 + arrowShift, 314, {
      color: sim.lineStop ? COLORS.danger : COLORS.a,
      font: '700 20px "SFMono-Regular", monospace',
      align: 'right',
    });
    ctx.restore();
  }

  drawGate(ctx, sim, now) {
    const target = sim.routeTarget();
    const activeLane = target?.plannedLane ?? null;
    const warning = sim.overflow.A || sim.overflow.B;
    ctx.save();
    ctx.fillStyle = '#122329';
    roundRect(ctx, 680, 248, 92, 128, 4);
    ctx.fill();
    ctx.strokeStyle = warning ? COLORS.danger : '#374c50';
    ctx.stroke();
    label(ctx, 'DIVERTER', 726, 265, {
      align: 'center',
      color: warning ? COLORS.danger : COLORS.muted,
      font: '700 8px "SFMono-Regular", monospace',
      letterSpacing: 1,
    });
    ctx.strokeStyle = '#51686b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(658, 314);
    ctx.lineTo(774, 314);
    ctx.stroke();
    const pulse = 0.45 + Math.sin(now / 220) * 0.16;
    if (activeLane === 'A') {
      ctx.strokeStyle = `rgba(255,196,92,${pulse})`;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(700, 308);
      ctx.lineTo(778, 245);
      ctx.stroke();
    } else if (activeLane === 'B') {
      ctx.strokeStyle = `rgba(100,216,203,${pulse})`;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(700, 321);
      ctx.lineTo(778, 432);
      ctx.stroke();
    }
    ctx.fillStyle = activeLane === 'A' ? COLORS.a : '#2d4246';
    ctx.beginPath();
    ctx.arc(708, 291, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = activeLane === 'B' ? COLORS.b : '#2d4246';
    ctx.beginPath();
    ctx.arc(708, 337, 5, 0, Math.PI * 2);
    ctx.fill();
    label(ctx, 'A', 722, 280, {
      color: COLORS.a,
      font: '700 9px "SFMono-Regular", monospace',
    });
    label(ctx, 'B', 722, 347, {
      color: COLORS.b,
      font: '700 9px "SFMono-Regular", monospace',
    });
    ctx.restore();
  }

  drawLanes(ctx, sim) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const lane of ['A', 'B']) {
      const color = lane === 'A' ? COLORS.a : COLORS.b;
      const y = lane === 'A' ? 238 : 454;
      ctx.strokeStyle = lane === 'A' ? 'rgba(255,196,92,0.36)' : 'rgba(100,216,203,0.33)';
      ctx.lineWidth = 34;
      ctx.beginPath();
      ctx.moveTo(770, 314);
      ctx.bezierCurveTo(794, 314, 786, y, 820, y);
      ctx.lineTo(1004, y);
      ctx.stroke();
      ctx.strokeStyle = '#132127';
      ctx.lineWidth = 24;
      ctx.beginPath();
      ctx.moveTo(770, 314);
      ctx.bezierCurveTo(794, 314, 786, y, 820, y);
      ctx.lineTo(1004, y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.11)';
      ctx.lineWidth = 1;
      ctx.setLineDash([12, 15]);
      ctx.beginPath();
      ctx.moveTo(820, y - 5);
      ctx.lineTo(998, y - 5);
      ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, `LANE ${lane}`, 815, y - 23, {
        color,
        font: '700 8px "SFMono-Regular", monospace',
        letterSpacing: 1,
      });
      const contamination = Math.min(1, sim.contamination[lane] / 2.5);
      if (contamination > 0.02) {
        const haze = ctx.createLinearGradient(800, y - 24, 1000, y + 24);
        haze.addColorStop(0, 'rgba(255,102,95,0)');
        haze.addColorStop(0.6, `rgba(255,102,95,${0.05 + contamination * 0.16})`);
        haze.addColorStop(1, 'rgba(255,102,95,0)');
        ctx.fillStyle = haze;
        ctx.fillRect(800, y - 24, 210, 48);
      }
    }
    ctx.restore();
  }

  drawCaches(ctx, sim, now) {
    for (const lane of ['A', 'B']) {
      const color = lane === 'A' ? COLORS.a : COLORS.b;
      const baseY = lane === 'A' ? 238 : 454;
      const cache = sim.caches[lane];
      const overflow = sim.overflow[lane];
      for (let index = 0; index < 6; index += 1) {
        const row = Math.floor(index / 3);
        const column = index % 3;
        const x = 1018 + column * 50;
        const y = baseY - 28 + row * 56;
        roundRect(ctx, x, y, 45, 48, 3);
        ctx.fillStyle = 'rgba(2, 9, 12, 0.46)';
        ctx.fill();
        ctx.strokeStyle =
          index < cache.length
            ? `${color}88`
            : 'rgba(142, 172, 169, 0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.018)';
        ctx.fillRect(x + 6, y + 7, 33, 2);
        ctx.fillRect(x + 6, y + 12, 24, 2);
      }
      label(ctx, `CACHE ${lane}`, 1018, baseY - 48, {
        color,
        font: '700 8px "SFMono-Regular", monospace',
        letterSpacing: 1,
      });
      label(ctx, `${cache.length}/6`, 1183, baseY - 48, {
        align: 'right',
        color: overflow ? COLORS.danger : cache.length >= 5 ? COLORS.a : COLORS.muted,
        font: '700 9px "SFMono-Regular", monospace',
      });
      if (overflow) {
        const flash = 0.28 + Math.sin(now / 160) * 0.16;
        ctx.fillStyle = `rgba(255,102,95,${flash})`;
        ctx.fillRect(1014, baseY - 38, 191, 99);
        ctx.strokeStyle = COLORS.danger;
        ctx.lineWidth = 2;
        ctx.strokeRect(1014, baseY - 38, 191, 99);
        label(ctx, 'BUFFER FULL · STOP UPSTREAM', 1019, baseY + 62, {
          color: COLORS.danger,
          font: '700 8px "SFMono-Regular", monospace',
          letterSpacing: 0.6,
        });
      }
    }
  }

  drawPacker(ctx, sim, now) {
    const packing = sim.packages.find((pkg) => pkg.status === 'packing');
    const pulse = 0.5 + Math.sin(now / 260) * 0.5;
    ctx.save();
    roundRect(ctx, 1131, 280, 116, 132, 5);
    ctx.fillStyle = '#0e2025';
    ctx.fill();
    ctx.strokeStyle = packing ? COLORS.b : '#344a4d';
    ctx.stroke();
    ctx.fillStyle = '#1c3336';
    ctx.fillRect(1144, 294, 89, 74);
    ctx.strokeStyle = 'rgba(100,216,203,0.26)';
    ctx.strokeRect(1149, 299, 79, 64);
    ctx.fillStyle = `rgba(100,216,203,${0.04 + pulse * 0.04})`;
    ctx.fillRect(1150, 300, 77, 62);
    label(ctx, 'PACKER', 1189, 402, {
      align: 'center',
      color: COLORS.b,
      font: '700 8px "SFMono-Regular", monospace',
      letterSpacing: 1,
    });
    label(ctx, `${sim.durability.p2.toFixed(0)}%`, 1239, 402, {
      align: 'right',
      color: sim.durability.p2 < 35 ? COLORS.danger : COLORS.muted,
      font: '9px "SFMono-Regular", monospace',
    });
    if (packing) {
      const progress = Math.min(
        1,
        Math.max(0, 1 - (packing.packingDue - sim.time) / 1.8)
      );
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(1149, 365, 79, 4);
      ctx.fillStyle = COLORS.b;
      ctx.fillRect(1149, 365, 79 * progress, 4);
    }
    const packed = sim.packages.filter((pkg) => pkg.status === 'packed').length;
    for (let index = 0; index < Math.min(5, packed); index += 1) {
      this.drawPackage(ctx, { id: index + 1, dest: index % 2 ? 'B' : 'A' }, 1086 + index * 19, 570, 30, 22, {
        dim: true,
        label: false,
      });
    }
    label(ctx, `PACKED ${String(packed).padStart(2, '0')}`, 1183, 585, {
      align: 'right',
      color: COLORS.muted,
      font: '700 9px "SFMono-Regular", monospace',
    });
    ctx.restore();
  }

  drawPackage(ctx, pkg, x, y, width, height, options = {}) {
    const color =
      pkg.dest === 'A'
        ? options.wrong
          ? COLORS.danger
          : COLORS.a
        : options.wrong
          ? COLORS.danger
          : COLORS.b;
    ctx.save();
    ctx.globalAlpha = options.dim ? 0.45 : 1;
    ctx.translate(x, y);
    if (options.jam) ctx.rotate(Math.sin(performance.now() / 40) * 0.025);
    roundRect(ctx, -width / 2, -height / 2, width, height, 3);
    const fill = ctx.createLinearGradient(-width / 2, -height / 2, width / 2, height / 2);
    fill.addColorStop(0, '#203037');
    fill.addColorStop(1, '#101c20');
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(-width * 0.3, -height * 0.28, width * 0.6, 2);
    ctx.globalAlpha *= 0.84;
    label(ctx, pkg.dest ?? '?', 0, 1, {
      align: 'center',
      color,
      font: `700 ${Math.max(8, Math.round(height * 0.38))}px "SFMono-Regular", monospace`,
    });
    if (options.label && pkg.serial) {
      ctx.globalAlpha = 0.82;
      label(ctx, pkg.serial.slice(-3), 0, height * 0.36, {
        align: 'center',
        color: '#839695',
        font: '6px "SFMono-Regular", monospace',
      });
    }
    ctx.restore();
  }

  drawPackages(ctx, sim, now) {
    const visible = sim.packages.filter((pkg) =>
      ['scanned', 'belt', 'lane', 'cache', 'blocked', 'packing'].includes(pkg.status)
    );
    for (const pkg of visible) {
      const wrong = pkg.plannedLane && pkg.plannedLane !== pkg.dest;
      const jam =
        pkg.status === 'blocked' ||
        pkg.jamUntil > sim.time ||
        pkg.status === 'packing';
      const width = pkg.status === 'cache' ? 34 : pkg.status === 'blocked' ? 31 : 40;
      const height = width * 0.72;
      this.drawPackage(ctx, pkg, pkg.x, pkg.y, width, height, {
        wrong,
        jam,
        label: pkg.status !== 'cache' || width > 32,
      });
      if (pkg.status === 'blocked') {
        ctx.save();
        ctx.strokeStyle = COLORS.danger;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pkg.x, pkg.y, 22 + Math.sin(now / 100) * 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawStatusOverlay(ctx, sim, options, now) {
    const warning = sim.overflow.A || sim.overflow.B;
    if (sim.lineStop) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,102,95,0.045)';
      ctx.fillRect(220, 270, 464, 92);
      ctx.strokeStyle = 'rgba(255,102,95,0.6)';
      ctx.setLineDash([9, 7]);
      ctx.strokeRect(220, 270, 464, 92);
      ctx.setLineDash([]);
      label(ctx, 'LINE STOP / 等待复线', 450, 351, {
        align: 'center',
        color: COLORS.danger,
        font: '700 10px "SFMono-Regular", monospace',
        letterSpacing: 1.2,
      });
      ctx.restore();
    }
    if (warning && !sim.lineStop) {
      const flash = 0.06 + (0.5 + Math.sin(now / 170) * 0.5) * 0.08;
      ctx.fillStyle = `rgba(255,102,95,${flash})`;
      ctx.fillRect(0, 0, W, H);
      label(ctx, 'BUFFER OVERFLOW · P1 STOP REQUIRED', 640, 88, {
        align: 'center',
        color: COLORS.danger,
        font: '700 12px "SFMono-Regular", monospace',
        letterSpacing: 1.4,
      });
    }
    const conflict = options.conflict;
    if (conflict?.objects?.length) {
      ctx.save();
      const point = conflict.objects.find((item) => item.position?.x > 0)?.position;
      if (point) {
        ctx.strokeStyle = COLORS.danger;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 32 + Math.sin(now / 100) * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(point.x - 44, point.y);
        ctx.lineTo(point.x - 24, point.y);
        ctx.moveTo(point.x + 24, point.y);
        ctx.lineTo(point.x + 44, point.y);
        ctx.moveTo(point.x, point.y - 44);
        ctx.lineTo(point.x, point.y - 24);
        ctx.moveTo(point.x, point.y + 24);
        ctx.lineTo(point.x, point.y + 44);
        ctx.stroke();
        label(
          ctx,
          `${conflict.kind === 'conflict' ? 'ORDER CONFLICT' : 'COLLISION'} @ ${point.x},${point.y}`,
          point.x + 39,
          point.y - 28,
          {
            color: COLORS.danger,
            font: '700 8px "SFMono-Regular", monospace',
          }
        );
      }
      ctx.restore();
    }
    if (options.replay) {
      ctx.save();
      ctx.fillStyle = 'rgba(5,12,16,0.76)';
      ctx.fillRect(W - 186, 19, 157, 29);
      ctx.strokeStyle = 'rgba(100,216,203,0.45)';
      ctx.strokeRect(W - 186, 19, 157, 29);
      label(ctx, `REPLAY ${options.replaySpeed ?? 1}×`, W - 170, 33, {
        color: COLORS.b,
        font: '700 9px "SFMono-Regular", monospace',
        letterSpacing: 1,
      });
      ctx.restore();
    }
    if (sim.phase === 'success' || sim.phase === 'failure') {
      const success = sim.phase === 'success';
      ctx.save();
      ctx.fillStyle = 'rgba(3,10,13,0.76)';
      ctx.fillRect(396, 184, 488, 185);
      ctx.strokeStyle = success ? COLORS.safe : COLORS.danger;
      ctx.lineWidth = 2;
      ctx.strokeRect(396, 184, 488, 185);
      label(ctx, success ? 'SHIFT COMPLETE' : 'SHIFT FAILED', 640, 229, {
        align: 'center',
        color: success ? COLORS.safe : COLORS.danger,
        font: '700 24px "Twin Sort SC", "DIN Alternate", "Bahnschrift", sans-serif',
        letterSpacing: 2,
      });
      label(
        ctx,
        success ? '全部包裹已装箱 · 错误率达标' : this.failureText(sim.failureReason),
        640,
        265,
        {
          align: 'center',
          color: '#b9c6c4',
          font: '11px "Twin Sort SC", "DIN Alternate", sans-serif',
        }
      );
      label(
        ctx,
        `${sim.stats.packed}/${sim.total} PACKED   ·   ${sim.stats.errors} ERR   ·   ${this.formatClock(sim.completedAt ?? sim.time)}`,
        640,
        310,
        {
          align: 'center',
          color: success ? COLORS.a : '#ff9a94',
          font: '700 9px "SFMono-Regular", monospace',
          letterSpacing: 0.9,
        }
      );
      label(ctx, '打开回放台可逐帧复核', 640, 340, {
        align: 'center',
        color: '#697e80',
        font: '9px "Twin Sort SC", "DIN Alternate", sans-serif',
      });
      ctx.restore();
    }
  }

  failureText(reason) {
    const messages = {
      cache_overflow_chain: '缓存溢出反压主带，连锁阻塞 3 个节拍',
      error_threshold: '错误率超过 6.0% 阈值',
      packer_durability: '装箱机耐久耗尽',
      scanner_durability: '扫描仪耐久耗尽',
      durability_depleted: '设备耐久耗尽',
      ten_minute_window: '十分钟窗口结束，仍有包裹未完成',
    };
    return messages[reason] ?? '班次终止';
  }

  formatClock(value) {
    const safe = Math.max(0, Number(value) || 0);
    const minutes = Math.floor(safe / 60);
    const seconds = Math.floor(safe % 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  render(sim, options = {}) {
    const ctx = this.ctx;
    const now = options.now ?? performance.now();
    this.background(ctx, now);
    this.floorStations(ctx, sim);
    this.drawConveyor(ctx, sim, now);
    this.drawLanes(ctx, sim);
    this.drawGate(ctx, sim, now);
    this.drawCaches(ctx, sim, now);
    this.drawPacker(ctx, sim, now);
    this.drawScanner(ctx, sim, now);
    this.drawQueue(ctx, sim);
    this.drawPackages(ctx, sim, now);
    this.drawStatusOverlay(ctx, sim, options, now);
  }
}
