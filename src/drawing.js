import { roundRectPath } from "./geometry.js";
import { dynamicBounds, textBounds } from "./scene.js";

export function resetContext(ctx, width, height) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, width, height);
}

export function drawBase(ctx, scene) {
  const { width, height } = scene.config;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#07191f");
  gradient.addColorStop(0.55, "#0a2225");
  gradient.addColorStop(1, "#102a29");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(102, 163, 145, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const grid = 48;
  const offsetX = -scene.camera.x % grid;
  const offsetY = -scene.camera.y % grid;
  for (let x = offsetX; x <= width; x += grid) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
  }
  for (let y = offsetY; y <= height; y += grid) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
  }
  ctx.stroke();
}

export function drawTerrain(ctx, scene) {
  if (!scene.layers.terrain) return;
  const { camera } = scene;
  const { width, height } = scene.config;
  const left = camera.x - 24;
  const top = camera.y - 24;
  const right = camera.x + width + 24;
  const bottom = camera.y + height + 24;

  for (const feature of scene.terrain) {
    if (
      feature.x + feature.w < left ||
      feature.x > right ||
      feature.y + feature.h < top ||
      feature.y > bottom
    ) {
      continue;
    }
    const x = feature.x - camera.x;
    const y = feature.y - camera.y;
    ctx.globalAlpha = feature.alpha;
    ctx.fillStyle = feature.color;
    if (feature.variant === 0) {
      ctx.fillRect(x, y, feature.w, feature.h);
    } else if (feature.variant === 1) {
      ctx.beginPath();
      ctx.moveTo(x, y + feature.h);
      ctx.lineTo(x + feature.w * 0.5, y);
      ctx.lineTo(x + feature.w, y + feature.h);
      ctx.closePath();
      ctx.fill();
    } else if (feature.variant === 2) {
      ctx.beginPath();
      ctx.ellipse(
        x + feature.w / 2,
        y + feature.h / 2,
        feature.w / 2,
        feature.h / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    } else {
      ctx.strokeStyle = feature.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y + feature.h * 0.5);
      ctx.lineTo(x + feature.w, y + feature.h * 0.5);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

export function drawTextCommand(ctx, text, command) {
  const x = text.x - text.cameraX;
  const y = text.y - text.cameraY;
  ctx.fillStyle = command.background;
  roundRectPath(ctx, x - 4, y - 3, command.width + 8, command.height + 6, 3);
  ctx.fill();
  ctx.font = command.font;
  ctx.fillStyle = command.color;
  ctx.textBaseline = "top";
  ctx.fillText(command.label, x, y);
}

export function screenTextBounds(text, camera) {
  const bounds = textBounds(text);
  return {
    x: bounds.x - camera.x,
    y: bounds.y - camera.y,
    w: bounds.w,
    h: bounds.h,
  };
}

export function screenDynamicBounds(object, camera) {
  const bounds = dynamicBounds(object);
  return {
    x: bounds.x - camera.x,
    y: bounds.y - camera.y,
    w: bounds.w,
    h: bounds.h,
  };
}

export function drawTexts(ctx, scene, textCache, filter = null) {
  if (!scene.layers.text) return 0;
  const { camera } = scene;
  const viewport = {
    x: camera.x,
    y: camera.y,
    w: scene.config.width,
    h: scene.config.height,
  };
  let drawn = 0;
  for (const text of scene.texts) {
    if (filter && !filter(text)) continue;
    const bounds = textBounds(text);
    if (
      bounds.x + bounds.w < viewport.x ||
      bounds.x > viewport.x + viewport.w ||
      bounds.y + bounds.h < viewport.y ||
      bounds.y > viewport.y + viewport.h
    ) {
      continue;
    }
    const command = textCache.prepare(text, ctx);
    text.cameraX = camera.x;
    text.cameraY = camera.y;
    drawTextCommand(ctx, text, command);
    drawn += 1;
  }
  return drawn;
}

export function drawObject(ctx, object, camera) {
  const x = object.x - camera.x;
  const y = object.y - camera.y;
  const radius = object.radius;
  ctx.globalAlpha = 0.96;
  ctx.fillStyle = `hsl(${object.hue} 74% 57%)`;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 1;
  ctx.strokeStyle = `hsl(${object.hue} 61% 78%)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#07191f";
  ctx.beginPath();
  if (object.shape === 0) {
    ctx.arc(x, y, radius * 0.32, 0, Math.PI * 2);
  } else if (object.shape === 1) {
    ctx.rect(x - radius * 0.25, y - radius * 0.25, radius * 0.5, radius * 0.5);
  } else {
    ctx.moveTo(x, y - radius * 0.4);
    ctx.lineTo(x + radius * 0.38, y + radius * 0.32);
    ctx.lineTo(x - radius * 0.38, y + radius * 0.32);
    ctx.closePath();
  }
  ctx.fill();
}

export function drawDynamics(ctx, scene) {
  if (!scene.layers.dynamic) return 0;
  const { camera } = scene;
  const viewport = {
    x: camera.x,
    y: camera.y,
    w: scene.config.width,
    h: scene.config.height,
  };
  let drawn = 0;
  for (const object of scene.dynamics) {
    if (!object.alive) continue;
    const bounds = dynamicBounds(object);
    if (
      bounds.x + bounds.w < viewport.x ||
      bounds.x > viewport.x + viewport.w ||
      bounds.y + bounds.h < viewport.y ||
      bounds.y > viewport.y + viewport.h
    ) {
      continue;
    }
    drawObject(ctx, object, camera);
    drawn += 1;
  }
  return drawn;
}
