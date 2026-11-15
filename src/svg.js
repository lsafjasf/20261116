import { interpolateKeyframe, normalizeProject } from "./project.js";

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function number(value) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function buildSceneSvg(projectInput, options = {}) {
  const project = normalizeProject(projectInput);
  const time = Number.isFinite(Number(options.time)) ? Number(options.time) : project.time;
  const includeBackground = options.includeBackground !== false;
  const scale = Number.isFinite(Number(options.scale)) && Number(options.scale) > 0
    ? Number(options.scale)
    : 1;
  const visibleLayers = [...project.layers].sort((a, b) => a.order - b.order);
  const layerMarkup = visibleLayers.map((layer, layerIndex) => {
    if (!layer.visible) return "";
    const frame = interpolateKeyframe(layer, time);
    const transform = [
      `translate(${number(frame.x)} ${number(frame.y)})`,
      `rotate(${number(frame.rotation)})`,
      `scale(${number(frame.scale)})`
    ].join(" ");
    const opacity = number(layer.opacity * frame.opacity);
    const paths = layer.paths
      .map((path) => (
        `<path data-path-id="${escapeAttribute(path.id)}" data-node-count="${path.nodeCount}" d="${escapeAttribute(path.d)}"/>`
      ))
      .join("");
    return `<g data-layer-id="${escapeAttribute(layer.id)}" data-layer-order="${layer.order}" data-layer-index="${layerIndex}" transform="${transform}" opacity="${opacity}" fill="${layer.color}" fill-rule="evenodd" shape-rendering="geometricPrecision">${paths}</g>`;
  }).join("");
  const background = includeBackground
    ? `<rect data-role="paper" width="${project.width}" height="${project.height}" fill="#fdfdfb"/>`
    : "";
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${project.width} ${project.height}" width="${number(project.width * scale)}" height="${number(project.height * scale)}" role="img" aria-label="${escapeAttribute(project.name)}">`,
    `<metadata>${escapeAttribute(JSON.stringify({ version: project.version, id: project.id, frame: time }))}</metadata>`,
    background,
    layerMarkup,
    "</svg>"
  ].join("");
  return {
    svg,
    time,
    visibleLayerCount: visibleLayers.filter((layer) => layer.visible).length,
    totalPathCount: visibleLayers.reduce(
      (sum, layer) => sum + (layer.visible ? layer.paths.length : 0),
      0
    )
  };
}

export function exportSvgDocument(project, time, options = {}) {
  const scene = buildSceneSvg(project, { time, scale: options.scale || 1 });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${scene.svg}\n`;
}

export function svgDataUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function renderSvgInto(element, project, time) {
  const scene = buildSceneSvg(project, { time });
  element.innerHTML = scene.svg;
  return scene;
}

export function nodeOverlayMarkup(layer, path, selectedPathId) {
  if (!path || path.id !== selectedPathId) return "";
  return path.points.map((point) => (
    `<circle cx="${number(point.x)}" cy="${number(point.y)}" r="2.4" fill="#f6efe6" stroke="#d9533f" stroke-width="1.2"/>`
  )).join("");
}
