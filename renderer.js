import { WORLD } from "./state.js";

const TYPE_LABEL = {
  note: "便签",
  "note-warm": "便签",
  "note-blue": "便签",
  poster: "海报",
  shape: "图形",
  sticker: "标签",
  text: "文字卡"
};

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export class CanvasRenderer {
  constructor({ viewport, world, objectsLayer, inkCanvas, zoomReadout, viewportReadout }) {
    this.viewport = viewport;
    this.world = world;
    this.objectsLayer = objectsLayer;
    this.inkCanvas = inkCanvas;
    this.ctx = inkCanvas.getContext("2d");
    this.zoomReadout = zoomReadout;
    this.viewportReadout = viewportReadout;
    this.objectMap = new Map();
    this.viewportState = { x: 0, y: 0, scale: 1 };
    this.knownIds = new Set();
  }

  rebuild(objects, selectedIds, animateNewId = null) {
    const selected = new Set(selectedIds);
    const fragment = document.createDocumentFragment();
    this.objectMap.clear();

    for (const object of objects) {
      const element = this.createObjectElement(object, selected.has(object.id));
      if (object.id === animateNewId) {
        element.classList.add("is-entering");
        window.setTimeout(() => element.classList.remove("is-entering"), 320);
      }
      this.objectMap.set(object.id, element);
      fragment.append(element);
    }

    this.objectsLayer.replaceChildren(fragment);
    this.knownIds = new Set(objects.map((object) => object.id));
  }

  createObjectElement(object, selected) {
    const element = createElement("button", `canvas-object object-${object.type}`);
    element.type = "button";
    element.dataset.objectId = object.id;
    element.setAttribute("role", "option");
    element.setAttribute("aria-selected", String(selected));
    element.setAttribute("aria-label", this.objectLabel(object, selected));
    element.style.left = `${object.x}px`;
    element.style.top = `${object.y}px`;
    element.style.width = `${object.width}px`;
    element.style.height = `${object.height}px`;
    element.classList.toggle("is-selected", selected);

    const surface = createElement("span", "object-surface");
    if (object.type === "shape") {
      const disc = createElement("span", "shape-disc");
      disc.append(createElement("span", "", "✦ 02"));
      surface.append(disc);
    } else if (object.type === "sticker") {
      const kicker = createElement("span", "object-kicker");
      kicker.append(createElement("span", "", "COORD"));
      surface.append(kicker, createElement("span", "object-title", object.title));
    } else {
      if (object.kicker) {
        const kicker = createElement("span", "object-kicker");
        kicker.append(createElement("span", "", object.kicker));
        kicker.append(createElement("span", "", object.type === "poster" ? "A3" : "↗"));
        surface.append(kicker);
      }
      if (object.title) {
        surface.append(createElement("span", "object-title", object.title));
      }
      if (object.body) {
        surface.append(createElement("span", "object-body", object.body));
      }
      if (object.footer) {
        const footer = createElement("span", "object-footer");
        footer.append(createElement("span", "mini-avatar", "LY"));
        footer.append(createElement("span", "", object.footer));
        surface.append(footer);
      }
    }

    element.append(surface);
    return element;
  }

  objectLabel(object, selected) {
    const type = TYPE_LABEL[object.type] || "对象";
    const position = `坐标 ${Math.round(object.x)}，${Math.round(object.y)}`;
    return `${object.title}，${type}，${position}，${selected ? "已选择" : "未选择"}`;
  }

  updateSelection(objects, selectedIds) {
    const selected = new Set(selectedIds);
    for (const object of objects) {
      const element = this.objectMap.get(object.id);
      if (!element) continue;
      const isSelected = selected.has(object.id);
      element.classList.toggle("is-selected", isSelected);
      element.setAttribute("aria-selected", String(isSelected));
      element.setAttribute("aria-label", this.objectLabel(object, isSelected));
    }
  }

  setViewport(viewport) {
    this.viewportState = { ...viewport };
    this.world.style.setProperty("--world-x", `${viewport.x}px`);
    this.world.style.setProperty("--world-y", `${viewport.y}px`);
    this.world.style.setProperty("--world-scale", viewport.scale);
    const gridSize = Math.max(8, 24 * viewport.scale);
    this.viewport.style.setProperty("--grid-size", `${gridSize}px`);
    this.viewport.style.setProperty("--grid-x", `${viewport.x}px`);
    this.viewport.style.setProperty("--grid-y", `${viewport.y}px`);
    const percent = Math.round(viewport.scale * 100);
    this.zoomReadout.value = `${percent}%`;
    this.zoomReadout.textContent = `${percent}%`;
    this.viewportReadout.textContent =
      `x ${Math.round(viewport.x)} · y ${Math.round(viewport.y)} · ${percent}%`;
  }

  setTool(tool) {
    this.viewport.classList.toggle("is-pen", tool === "pen");
  }

  setDragging(isDragging) {
    this.viewport.classList.toggle("is-dragging", Boolean(isDragging));
  }

  setPinching(isPinching) {
    this.viewport.classList.toggle("is-pinching", Boolean(isPinching));
  }

  clientToLocal(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  clientToWorld(clientX, clientY, viewport = this.viewportState) {
    const local = this.clientToLocal(clientX, clientY);
    return {
      x: (local.x - viewport.x) / viewport.scale,
      y: (local.y - viewport.y) / viewport.scale
    };
  }

  worldToClient(x, y, viewport = this.viewportState) {
    const rect = this.viewport.getBoundingClientRect();
    return {
      x: rect.left + viewport.x + x * viewport.scale,
      y: rect.top + viewport.y + y * viewport.scale
    };
  }

  viewportCenterWorld(viewport = this.viewportState) {
    const rect = this.viewport.getBoundingClientRect();
    return {
      x: (rect.width / 2 - viewport.x) / viewport.scale,
      y: (rect.height / 2 - viewport.y) / viewport.scale
    };
  }

  reanchorAfterResize(previousViewport, worldCenter) {
    const rect = this.viewport.getBoundingClientRect();
    return {
      x: rect.width / 2 - worldCenter.x * previousViewport.scale,
      y: rect.height / 2 - worldCenter.y * previousViewport.scale,
      scale: previousViewport.scale
    };
  }

  fitViewport(objects, padding = 66) {
    const rect = this.viewport.getBoundingClientRect();
    if (!objects.length) {
      return { x: rect.width / 2, y: rect.height / 2, scale: 1 };
    }
    const minX = Math.min(...objects.map((object) => object.x));
    const minY = Math.min(...objects.map((object) => object.y));
    const maxX = Math.max(...objects.map((object) => object.x + object.width));
    const maxY = Math.max(...objects.map((object) => object.y + object.height));
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const scale = Math.min(1.15, Math.max(0.28, Math.min(
      (rect.width - padding * 2) / contentWidth,
      (rect.height - padding * 2) / contentHeight
    )));
    return {
      x: (rect.width - contentWidth * scale) / 2 - minX * scale,
      y: (rect.height - contentHeight * scale) / 2 - minY * scale,
      scale
    };
  }

  drawInk(strokes, draftStroke = null) {
    const { ctx } = this;
    ctx.clearRect(0, 0, WORLD.width, WORLD.height);
    for (const stroke of strokes) {
      this.drawStroke(stroke);
    }
    if (draftStroke && draftStroke.points.length > 1) {
      this.drawStroke(draftStroke);
    }
  }

  drawStroke(stroke) {
    const { ctx } = this;
    const points = stroke.points;
    if (!points.length) return;
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) {
      ctx.arc(points[0].x, points[0].y, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      for (let index = 1; index < points.length - 1; index += 1) {
        const current = points[index];
        const next = points[index + 1];
        ctx.quadraticCurveTo(
          current.x,
          current.y,
          (current.x + next.x) / 2,
          (current.y + next.y) / 2
        );
      }
      const last = points[points.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  focusObject(objectId) {
    const element = this.objectMap.get(objectId);
    if (element) {
      element.focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  focusViewport() {
    this.viewport.focus({ preventScroll: true });
  }
}
