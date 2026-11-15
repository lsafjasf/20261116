import { round } from "./core.js";

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function textElement(item, role, extra = "") {
  return `<text x="${round(item.x ?? item.textX)}" y="${round(item.y ?? item.textY)}" ` +
    `font-size="${item.fontSize ?? 11}" text-anchor="${item.anchor ?? "middle"}" ` +
    `dominant-baseline="middle" data-role="${role}" ${extra}>${escapeXml(item.text ?? item.label ?? item.name)}</text>`;
}

function backgroundLayer(layout, spec) {
  return `<g data-layer="background">` +
    `<rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="${spec.background}"/>` +
    `<rect x="${layout.plot.x}" y="${layout.plot.y}" width="${layout.plot.width}" ` +
    `height="${layout.plot.height}" rx="3" fill="#0f18270a" stroke="#cbd5e1" stroke-width="0.8"/>` +
    `</g>`;
}

function gridLayer(layout) {
  const vertical = layout.ticks.x.map((tick) =>
    `<line x1="${round(tick.x)}" y1="${layout.plot.y}" x2="${round(tick.x)}" ` +
    `y2="${round(layout.plot.y + layout.plot.height)}" data-tick="${tick.value}"/>`
  ).join("");
  const horizontal = layout.ticks.y.map((tick) =>
    `<line x1="${layout.plot.x}" y1="${round(tick.cy ?? tick.y)}" ` +
    `x2="${round(layout.plot.x + layout.plot.width)}" y2="${round(tick.cy ?? tick.y)}" ` +
    `data-tick="${tick.value}"/>`
  ).join("");
  return `<g data-layer="grid" class="grid">${vertical}${horizontal}</g>`;
}

function axesLayer(layout) {
  const xTicks = layout.ticks.x.map((tick) =>
    `<line class="tick-mark" x1="${round(tick.x)}" y1="${layout.plot.y + layout.plot.height}" ` +
    `x2="${round(tick.x)}" y2="${layout.plot.y + layout.plot.height + 5}"/>` +
    textElement(tick, "tick-x-label", `data-value="${round(tick.value, 6)}" data-label-box="x"`)
  ).join("");
  const yTicks = layout.ticks.y.map((tick) =>
    `<line class="tick-mark" x1="${layout.plot.x - 5}" y1="${round(tick.cy ?? tick.y)}" ` +
    `x2="${layout.plot.x}" y2="${round(tick.cy ?? tick.y)}"/>` +
    textElement(tick, "tick-y-label", `data-value="${round(tick.value, 6)}" data-label-box="y"`)
  ).join("");
  const xAxis = layout.axes.x
    ? textElement({ ...layout.axes.x, text: layout.axes.x.text }, "axis-label-x", `data-label-box="axis"`)
    : "";
  const yAxis = layout.axes.y
    ? `<text x="${round(layout.axes.y.x)}" y="${round(layout.axes.y.y)}" font-size="${layout.axes.y.fontSize}" ` +
      `text-anchor="${layout.axes.y.anchor}" dominant-baseline="middle" ` +
      `transform="rotate(-90 ${round(layout.axes.y.x)} ${round(layout.axes.y.y)})" ` +
      `data-role="axis-label-y" data-label-box="axis">${escapeXml(layout.axes.y.text)}</text>`
    : "";
  return `<g data-layer="axes" class="axes">` +
    `<line class="axis-line" x1="${layout.plot.x}" y1="${layout.plot.bottom}" ` +
    `x2="${layout.plot.x + layout.plot.width}" y2="${layout.plot.bottom}"/>` +
    `<line class="axis-line" x1="${layout.plot.x}" y1="${layout.plot.y}" ` +
    `x2="${layout.plot.x}" y2="${layout.plot.bottom}"/>` +
    xTicks + yTicks + xAxis + yAxis + `</g>`;
}

function dataLayer(layout, type, clipId) {
  const matching = layout.series.filter((series) => series.type === type);
  if (!matching.length) return "";
  let content = "";
  for (const series of matching) {
    if (type === "area") {
      for (const segment of series.segments) {
        if (segment.points.length > 1) {
          content += `<path d="${segment.area}" fill="${series.color}" fill-opacity="${round(series.opacity * 0.16, 3)}" ` +
            `stroke="none" data-series-id="${escapeXml(series.id)}"/>`;
          content += `<path d="${segment.line}" fill="none" stroke="${series.color}" ` +
            `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ` +
            `data-series-id="${escapeXml(series.id)}"/>`;
        }
      }
    } else if (type === "line") {
      for (const segment of series.segments) {
        content += `<path class="series-line" d="${segment.line}" fill="none" stroke="${series.color}" ` +
          `stroke-opacity="${round(series.opacity, 3)}" data-series-id="${escapeXml(series.id)}"/>`;
      }
    } else {
      for (const point of series.points) {
        const radius = point.radius ?? 4;
        content += `<circle class="series-point" cx="${round(point.px)}" cy="${round(point.py)}" ` +
          `r="${radius}" fill="${series.color}" fill-opacity="${round(series.opacity, 3)}" ` +
          `stroke="#ffffff" stroke-width="1.1" data-series-id="${escapeXml(series.id)}" ` +
          `data-data-x="${point.x}" data-data-y="${point.y}"/>`;
      }
    }
  }
  return `<g data-layer="${type}" clip-path="url(#${clipId})">${content}</g>`;
}

function emptyLayer(layout) {
  if (!layout.emptyState) return "";
  const empty = layout.emptyState;
  return `<g data-layer="annotations" data-empty-state="true">` +
    `<rect x="${round(empty.bbox.x)}" y="${round(empty.bbox.y)}" ` +
    `width="${round(empty.bbox.width)}" height="${round(empty.bbox.height)}" rx="6" ` +
    `fill="#f8fafc" stroke="#cbd5e1"/>` +
    textElement(empty, "empty-state") +
    `</g>`;
}

function annotationsLayer(layout) {
  const items = layout.annotations.map((item) => {
    return `<g class="annotation" data-label="${escapeXml(item.text)}">` +
      `<line class="annotation-leader" x1="${round(item.leader.x1)}" y1="${round(item.leader.y1)}" ` +
      `x2="${round(item.leader.x2)}" y2="${round(item.leader.y2)}" stroke="${item.color}"/>` +
      `<rect class="annotation-bg" x="${round(item.bbox.x)}" y="${round(item.bbox.y)}" ` +
      `width="${round(item.bbox.width)}" height="${round(item.bbox.height)}" rx="4" ` +
      `stroke="${item.color}"/>` +
      textElement(
        { text: item.text, x: item.textX, y: item.textY, fontSize: item.fontSize, anchor: item.anchor },
        "annotation-label",
        `data-label-box="annotation"`
      ) +
      `</g>`;
  }).join("");
  return `<g data-layer="annotations">${items}</g>`;
}

function headerLayer(layout) {
  const title = layout.header.title;
  const subtitle = layout.header.subtitle;
  return `<g data-layer="header">` +
    textElement(
      { text: title.text, x: title.x, y: title.y, fontSize: title.fontSize, anchor: "start" },
      "chart-title",
      `font-weight="750" data-label-box="title"`
    ) +
    (subtitle
      ? textElement(
          { text: subtitle.text, x: subtitle.x, y: subtitle.y, fontSize: subtitle.fontSize, anchor: "start" },
          "chart-subtitle",
          `data-label-box="subtitle"`
        )
      : "") +
    `</g>`;
}

function legendMarker(item) {
  if (item.type === "scatter") {
    return `<circle cx="${round(item.markerX + 5)}" cy="${round(item.markerY)}" r="4" fill="${item.color}"/>`;
  }
  if (item.type === "area") {
    return `<rect x="${round(item.markerX)}" y="${round(item.markerY - 4)}" width="14" height="8" ` +
      `rx="2" fill="${item.color}" fill-opacity="0.18"/>` +
      `<line x1="${round(item.markerX)}" y1="${round(item.markerY)}" ` +
      `x2="${round(item.markerX + 14)}" y2="${round(item.markerY)}" stroke="${item.color}" stroke-width="2"/>`;
  }
  return `<line x1="${round(item.markerX)}" y1="${round(item.markerY)}" ` +
    `x2="${round(item.markerX + 12)}" y2="${round(item.markerY)}" stroke="${item.color}" stroke-width="2.2"/>`;
}

function legendLayer(layout) {
  const items = layout.legend.items.map((item) => {
    return `<g class="legend-item" data-series-id="${escapeXml(item.id)}">` +
      `<rect class="legend-hit" x="${round(item.x)}" y="${round(item.y)}" ` +
      `width="${round(item.width)}" height="${round(item.height)}" rx="4" fill="transparent"/>` +
      legendMarker(item) +
      textElement(
        { text: item.name, x: item.textX, y: item.textY, fontSize: layout.fontSize, anchor: "start" },
        "legend-label",
        `data-label-box="legend" data-series-id="${escapeXml(item.id)}"`
      ) +
      `</g>`;
  }).join("");
  return `<g data-layer="legend">${items}</g>`;
}

function metadata(layout, spec) {
  const payload = {
    layoutHash: layout.hash,
    screenPreview: true,
    exportSurface: "same-svg-layout",
    layerOrder: layout.layerOrder,
    plot: layout.plot,
    domains: layout.domains,
    ticks: {
      x: layout.ticks.x.map((tick) => ({ value: tick.value, label: tick.label, x: round(tick.x) })),
      y: layout.ticks.y.map((tick) => ({ value: tick.value, label: tick.label, y: round(tick.cy ?? tick.y) }))
    },
    legend: layout.legend.items.map((item) => ({ id: item.id, x: round(item.x), y: round(item.y) })),
    warnings: layout.warnings,
    summary: layout.summary
  };
  return `<metadata id="chart-meta">${escapeXml(JSON.stringify(payload))}</metadata>`;
}

export function renderChartSVG(layout, spec, options = {}) {
  const prefix = options.idPrefix || "chart";
  const clipId = `${prefix}-clip-${layout.hash}`;
  const title = layout.header.title;
  const layers = {
    background: backgroundLayer(layout, spec),
    grid: gridLayer(layout),
    axes: axesLayer(layout),
    area: dataLayer(layout, "area", clipId),
    line: dataLayer(layout, "line", clipId),
    scatter: dataLayer(layout, "scatter", clipId),
    annotations: annotationsLayer(layout),
    header: headerLayer(layout),
    legend: legendLayer(layout)
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `width="${layout.width}" height="${layout.height}" data-layout-hash="${layout.hash}" ` +
    `data-chart-id="${escapeXml(prefix)}" aria-labelledby="${prefix}-title ${prefix}-desc">` +
    metadata(layout, spec) +
    `<title id="${prefix}-title">${escapeXml(title.text)}</title>` +
    `<desc id="${prefix}-desc">${escapeXml(`${spec.title}${spec.subtitle ? `，${spec.subtitle}` : ""}。共享布局图表预览与导出。`)}</desc>` +
    `<style>` +
    `svg{font-family:${escapeXml(spec.fontFamily)};color:#263447}` +
    `text{fill:#263447}` +
    `.grid line{stroke:#dbe3ec;stroke-width:.8}` +
    `.axes .axis-line,.axes .tick-mark{stroke:#7a8798;stroke-width:1}` +
    `.series-line{fill:none;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}` +
    `.annotation-bg{fill:#ffffff;fill-opacity:.96;stroke-width:.9}` +
    `.annotation-leader{stroke-width:1;stroke-dasharray:3 3;opacity:.75}` +
    `.annotation text{fill:#29364a;font-weight:600}` +
    `.annotation-bg{filter:drop-shadow(0 1px 1px #0f18270d)}` +
    `</style>` +
    `<defs><clipPath id="${clipId}"><rect x="${layout.plot.x}" y="${layout.plot.y}" ` +
    `width="${layout.plot.width}" height="${layout.plot.height}" rx="3"/></clipPath></defs>` +
    layers.background +
    layers.grid +
    layers.axes +
    layers.area +
    layers.line +
    layers.scatter +
    emptyLayer(layout) +
    layers.annotations +
    layers.header +
    layers.legend +
    `</svg>`;
}
