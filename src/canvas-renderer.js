function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

function applyShadow(ctx, shadow) {
  if (!shadow) return;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur ?? 0;
  ctx.shadowOffsetX = shadow.offsetX ?? 0;
  ctx.shadowOffsetY = shadow.offsetY ?? 0;
}

function clearShadow(ctx) {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function drawText(ctx, command) {
  ctx.save();
  ctx.font = command.font;
  ctx.fillStyle = command.color;
  ctx.textBaseline = "top";
  ctx.textAlign = command.align === "center" ? "center" : command.align === "right" ? "right" : "left";
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${command.letterSpacing ?? 0}px`;
  const anchorX =
    command.align === "center"
      ? command.x + command.w / 2
      : command.align === "right"
        ? command.x + command.w
        : command.x;
  const lineHeight = command.fontSize * command.lineHeight;
  command.lines.forEach((line, index) => {
    ctx.fillText(line, anchorX, command.y + index * lineHeight);
  });
  ctx.restore();
}

export function drawCommands(ctx, commands) {
  for (const command of commands) {
    if (command.kind === "group") {
      ctx.save();
      ctx.globalAlpha *= Math.max(0, Math.min(1, command.opacity ?? 1));
      if (command.rotation) {
        ctx.translate(command.centerX, command.centerY);
        ctx.rotate((command.rotation * Math.PI) / 180);
        ctx.translate(-command.centerX, -command.centerY);
      }
      if (command.clip) {
        roundedRect(
          ctx,
          command.clip.x,
          command.clip.y,
          command.clip.w,
          command.clip.h,
          command.clip.radius,
        );
        ctx.clip();
      }
      drawCommands(ctx, command.commands);
      ctx.restore();
      continue;
    }
    if (command.kind === "rect") {
      ctx.save();
      applyShadow(ctx, command.shadow);
      roundedRect(ctx, command.x, command.y, command.w, command.h, command.radius);
      if (command.fill) {
        ctx.fillStyle = command.fill;
        ctx.fill();
      }
      clearShadow(ctx);
      if (command.stroke) {
        ctx.strokeStyle = command.stroke;
        ctx.lineWidth = command.strokeWidth;
        ctx.stroke();
      }
      ctx.restore();
      continue;
    }
    if (command.kind === "ellipse") {
      ctx.save();
      applyShadow(ctx, command.shadow);
      ctx.beginPath();
      ctx.ellipse(
        command.x + command.w / 2,
        command.y + command.h / 2,
        command.w / 2,
        command.h / 2,
        0,
        0,
        Math.PI * 2,
      );
      if (command.fill) {
        ctx.fillStyle = command.fill;
        ctx.fill();
      }
      clearShadow(ctx);
      if (command.stroke) {
        ctx.strokeStyle = command.stroke;
        ctx.lineWidth = command.strokeWidth;
        ctx.stroke();
      }
      ctx.restore();
      continue;
    }
    if (command.kind === "line") {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(command.x1, command.y1);
      ctx.lineTo(command.x2, command.y2);
      ctx.strokeStyle = command.color;
      ctx.lineWidth = command.width;
      ctx.stroke();
      ctx.restore();
      continue;
    }
    if (command.kind === "text") drawText(ctx, command);
  }
}

export function drawArtboardShadow(ctx, width, height) {
  ctx.save();
  ctx.shadowColor = "rgba(38, 44, 35, 0.2)";
  ctx.shadowBlur = 34;
  ctx.shadowOffsetY = 16;
  ctx.fillStyle = "#F2EDE3";
  roundedRect(ctx, 0, 0, width, height, 3);
  ctx.fill();
  ctx.restore();
}
