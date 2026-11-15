import {
  CHAPTERS,
  formatCompact,
  formatNumber,
  formatPct,
  formatSpeed,
  getDistrict
} from "./core.js";

export function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalized(value, min, max) {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function speedColor(speed) {
  if (!Number.isFinite(speed)) return "#7d8279";
  if (speed < 16) return "#dc5538";
  if (speed < 23) return "#c4952f";
  if (speed < 31) return "#11766f";
  return "#2d6d96";
}

function mapPalette(dataset, corridor) {
  return getDistrict(dataset, corridor.districtId)?.tone ?? "#e25738";
}

export function buildMap(dataset, view, chapterId, filters) {
  const selectedCorridors = new Map(view.corridors.map((corridor) => [corridor.id, corridor]));
  const maxFlow = Math.max(1, ...view.corridors.map((corridor) => corridor.flow));
  const focusId = view.topCorridor?.id ?? null;
  const activeDistrict = filters.districtId;
  const parts = [];

  parts.push('<svg class="city-map-svg" viewBox="0 0 600 480" role="img" aria-labelledby="mapSvgTitle mapSvgDesc">');
  parts.push('<title id="mapSvgTitle">临江市交通概况</title>');
  const mapDescription = chapterId === "speed"
    ? `地图以颜色展示各走廊速度，${view.slowestCorridor?.name ?? "暂无"}最慢。`
    : chapterId === "transit"
      ? `地图以线宽展示各走廊流量，公交共承担 ${formatPct(view.transitShare, 1)}。`
      : `地图以线宽展示各走廊流量，${view.topCorridor?.name ?? "暂无"}最高。`;
  parts.push(`<desc id="mapSvgDesc">${escapeXml(mapDescription)}</desc>`);
  parts.push('<rect class="map-bg" width="600" height="480"/>');

  for (let x = 40; x < 600; x += 62) {
    parts.push(`<line class="map-grid" x1="${x}" y1="0" x2="${x}" y2="480"/>`);
  }
  for (let y = 40; y < 480; y += 58) {
    parts.push(`<line class="map-grid" x1="0" y1="${y}" x2="600" y2="${y}"/>`);
  }

  parts.push('<path class="map-river" d="M -20 306 C 88 260, 148 344, 238 322 S 384 260, 470 298 S 552 360, 622 324"/>');
  parts.push('<path class="map-river-line" d="M -20 306 C 88 260, 148 344, 238 322 S 384 260, 470 298 S 552 360, 622 324"/>');

  for (const district of dataset.districts) {
    const isMuted = activeDistrict !== "all" && activeDistrict !== district.id;
    const districtData = view.districts.find((item) => item.id === district.id);
    const radius = chapterId === "transit" && districtData
      ? 11 + normalized(districtData.transitShare ?? 0, 0.2, 0.5) * 12
      : 16;
    parts.push(`<g${isMuted ? ' opacity="0.28"' : ""}>`);
    parts.push(`<circle class="map-district-halo" cx="${district.center[0]}" cy="${district.center[1]}" r="${radius + 14}" style="--district-tone:${district.tone}"/>`);
    parts.push(`<circle class="map-district-dot" cx="${district.center[0]}" cy="${district.center[1]}" r="${radius / 3.2}" style="--district-tone:${district.tone}"/>`);
    parts.push(`<text class="map-district-label" x="${district.center[0] + 10}" y="${district.center[1] - 10}">${escapeXml(district.name)}</text>`);
    parts.push("</g>");
  }

  dataset.corridors.forEach((corridor, index) => {
    const metric = selectedCorridors.get(corridor.id);
    const isMuted = !metric || (activeDistrict !== "all" && corridor.districtId !== activeDistrict);
    const flowRatio = metric ? normalized(metric.flow, 0, maxFlow) : 0;
    const strokeWidth = chapterId === "speed" ? 7 : 3.5 + flowRatio * 10;
    const color = chapterId === "speed" ? speedColor(metric?.avgSpeed) : mapPalette(dataset, corridor);
    const opacity = metric ? 0.94 : 0.18;
    const points = corridor.path.map((point) => point.join(",")).join(" ");
    parts.push(`<g class="map-corridor${isMuted ? " is-dim" : ""}${corridor.id === focusId ? " is-focus" : ""}" data-corridor="${escapeXml(corridor.id)}">`);
    parts.push(`<polyline class="map-corridor-shadow" points="${points}" stroke-width="${strokeWidth + 3.5}"/>`);
    parts.push(`<polyline class="map-corridor-line" points="${points}" stroke-width="${strokeWidth}" style="--corridor-color:${color};opacity:${opacity}"/>`);
    if (metric) {
      const endpoint = corridor.path[corridor.path.length - 1];
      parts.push(`<circle class="map-endpoint" cx="${endpoint[0]}" cy="${endpoint[1]}" r="${3 + flowRatio * 2}" style="--corridor-color:${color}"/>`);
    }
    parts.push("</g>");
  });

  parts.push('<g opacity="0.55">');
  parts.push('<path d="M 508 435 l 0 -18 m -4 4 l 4 -4 l 4 4" fill="none" stroke="#19211c" stroke-width="1.2"/>');
  parts.push('<text class="chart-tick" x="508" y="455" text-anchor="middle">N</text>');
  parts.push("</g>");
  parts.push("</svg>");

  return {
    html: parts.join(""),
    modeLabel: chapterId === "speed" ? "颜色 = 加权速度" : chapterId === "transit" ? "圆点 = 公交分担" : "线宽 = 当前流量",
    caption: mapDescription,
    ariaLabel: mapDescription
  };
}

function legend(items) {
  return `<div class="chart-legend">${items.map((item) => (
    `<span><i style="--legend-color:${item.color}"></i>${escapeXml(item.label)}</span>`
  )).join("")}</div>`;
}

function emptyChart(message) {
  return {
    html: `<div class="chart-empty">${escapeXml(message)}</div>`,
    title: "没有可绘制数据",
    subtitle: "筛选后的对象数为 0",
    legend: "",
    warning: "",
    buttonHidden: true,
    buttonLabel: "",
    buttonPressed: false,
    ariaLabel: message
  };
}

function axisY(maxValue, y, height, ticks = 3) {
  const items = [];
  for (let index = 0; index <= ticks; index += 1) {
    const ratio = index / ticks;
    const value = maxValue * ratio;
    const lineY = y + height - ratio * height;
    items.push(`<line class="chart-grid-line" x1="45" y1="${lineY}" x2="680" y2="${lineY}"/>`);
    items.push(`<text class="chart-tick" x="39" y="${lineY + 3}" text-anchor="end">${escapeXml(formatCompact(value))}</text>`);
  }
  return items.join("");
}

function flowChart(view) {
  if (!view.hours.length) return emptyChart("当前筛选没有逐小时流量可绘制。");
  const width = 700;
  const height = 228;
  const margin = { left: 45, right: 20, top: 18, bottom: 36 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(1, ...view.hours.map((hour) => hour.inbound + hour.outbound));
  const slot = plotWidth / Math.max(1, view.hours.length);
  const barWidth = Math.min(30, slot * 0.52);
  const parts = [];
  parts.push(`<svg class="story-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(`逐小时入城与出城流量，共 ${view.rowCount} 条观测`)}">`);
  parts.push(axisY(maxValue, margin.top, plotHeight));
  parts.push(`<line class="chart-axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"/>`);

  view.hours.forEach((hour, index) => {
    const centerX = margin.left + slot * index + slot / 2;
    const inboundHeight = (hour.inbound / maxValue) * plotHeight;
    const outboundHeight = (hour.outbound / maxValue) * plotHeight;
    const baseY = height - margin.bottom;
    parts.push(`<g class="bar-group"><title>${hour.label}：入城 ${formatNumber(hour.inbound)}，出城 ${formatNumber(hour.outbound)}</title>`);
    if (hour.inbound > 0) {
      parts.push(`<rect class="bar-inbound" x="${centerX - barWidth / 2}" y="${baseY - inboundHeight}" width="${barWidth}" height="${inboundHeight}"/>`);
    }
    if (hour.outbound > 0) {
      parts.push(`<rect class="bar-outbound" x="${centerX - barWidth / 2}" y="${baseY - inboundHeight - outboundHeight}" width="${barWidth}" height="${outboundHeight}"/>`);
    }
    parts.push(`<text class="chart-tick" x="${centerX}" y="${baseY + 15}" text-anchor="middle">${String(hour.hour).padStart(2, "0")}</text>`);
    parts.push("</g>");
  });
  parts.push("</svg>");
  return {
    html: parts.join("") + legend([
      { color: "#e25738", label: "入城" },
      { color: "#39413a", label: "出城" }
    ]),
    title: "逐小时流量",
    subtitle: "入城 / 出城可相加 · 堆叠柱",
    legend: "",
    warning: "",
    buttonHidden: true,
    buttonLabel: "",
    buttonPressed: false,
    ariaLabel: `逐小时流量柱状图，${view.hours.length} 个时段。`
  };
}

function speedChart(view, stackAttempted) {
  if (!view.corridors.length) return emptyChart("当前筛选没有走廊速度可绘制。");
  const corridors = [...view.corridors].sort((left, right) => (left.avgSpeed ?? 0) - (right.avgSpeed ?? 0));
  const width = 700;
  const height = 228;
  const left = 105;
  const right = 58;
  const top = 18;
  const bottom = 20;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxSpeed = Math.max(40, Math.ceil(Math.max(...corridors.map((item) => item.avgSpeed ?? 0)) / 10) * 10);
  const rowHeight = plotHeight / corridors.length;
  const parts = [];
  parts.push(`<svg class="story-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(`走廊速度排行，${view.slowestCorridor?.name ?? ""}最慢`)}">`);
  parts.push(`<line class="chart-axis" x1="${left}" y1="${top - 5}" x2="${left}" y2="${height - bottom}"/>`);
  for (let tick = 0; tick <= maxSpeed; tick += 10) {
    const x = left + (tick / maxSpeed) * plotWidth;
    parts.push(`<line class="chart-grid-line" x1="${x}" y1="${top - 4}" x2="${x}" y2="${height - bottom}"/>`);
    parts.push(`<text class="chart-tick" x="${x}" y="${height - bottom + 13}" text-anchor="middle">${tick}</text>`);
  }
  corridors.forEach((corridor, index) => {
    const y = top + rowHeight * index + rowHeight / 2;
    const speed = corridor.avgSpeed ?? 0;
    const x = left + (speed / maxSpeed) * plotWidth;
    const color = speedColor(speed);
    parts.push(`<g><title>${escapeXml(`${corridor.name}：${formatSpeed(speed)} 公里/小时`)}</title>`);
    parts.push(`<text class="speed-label" x="${left - 9}" y="${y + 3}" text-anchor="end">${escapeXml(corridor.name)}</text>`);
    parts.push(`<line class="speed-track" x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}"/>`);
    parts.push(`<line class="speed-line" x1="${left}" y1="${y}" x2="${x}" y2="${y}" style="--speed-color:${color}"/>`);
    parts.push(`<circle class="speed-dot" cx="${x}" cy="${y}" r="4.5" style="--speed-color:${color}"/>`);
    parts.push(`<text class="speed-value" x="${x + 9}" y="${y + 3}">${formatSpeed(speed)}</text>`);
    parts.push("</g>");
  });
  parts.push(`<text class="chart-tick" x="${width - 4}" y="${height - 3}" text-anchor="end">km/h</text>`);
  parts.push("</svg>");
  return {
    html: parts.join("") + legend([
      { color: "#dc5538", label: "< 16" },
      { color: "#c4952f", label: "16–23" },
      { color: "#11766f", label: "23–31" },
      { color: "#2d6d96", label: "≥ 31 km/h" }
    ]),
    title: "走廊速度排行",
    subtitle: "加权速度是强度指标 · 不可堆叠",
    warning: stackAttempted
      ? "无法堆叠：速度表示强度，不能相加。已保留各走廊独立的速度视图，筛选与章节状态均未改变。"
      : "",
    buttonHidden: false,
    buttonLabel: stackAttempted ? "恢复分组" : "尝试堆叠",
    buttonPressed: stackAttempted,
    ariaLabel: `走廊速度横向图，共 ${corridors.length} 条走廊。`
  };
}

function transitChart(view) {
  if (!view.districts.length) return emptyChart("当前筛选没有片区出行结构可绘制。");
  const width = 700;
  const height = 228;
  const margin = { left: 48, right: 20, top: 20, bottom: 42 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxValue = Math.max(1, ...view.districts.map((district) => district.flow));
  const slot = plotWidth / view.districts.length;
  const barWidth = Math.min(46, slot * 0.52);
  const parts = [];
  parts.push(`<svg class="story-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(`各片区公交与其他方式流量堆叠柱，公交分担率 ${formatPct(view.transitShare, 1)}`)}">`);
  parts.push(axisY(maxValue, margin.top, plotHeight));
  parts.push(`<line class="chart-axis" x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}"/>`);
  view.districts.forEach((district, index) => {
    const centerX = margin.left + slot * index + slot / 2;
    const busHeight = (district.busRiders / maxValue) * plotHeight;
    const otherHeight = (district.otherRiders / maxValue) * plotHeight;
    const baseY = height - margin.bottom;
    parts.push(`<g><title>${escapeXml(`${district.name}：公交 ${formatNumber(district.busRiders)}，其他 ${formatNumber(district.otherRiders)}`)}</title>`);
    parts.push(`<rect class="bar-other" x="${centerX - barWidth / 2}" y="${baseY - otherHeight}" width="${barWidth}" height="${otherHeight}"/>`);
    parts.push(`<rect class="bar-bus" x="${centerX - barWidth / 2}" y="${baseY - otherHeight - busHeight}" width="${barWidth}" height="${busHeight}"/>`);
    parts.push(`<text class="chart-tick" x="${centerX}" y="${baseY + 15}" text-anchor="middle">${escapeXml(district.name)}</text>`);
    parts.push(`<text class="chart-value-label" x="${centerX}" y="${baseY - otherHeight - busHeight - 5}" text-anchor="middle">${formatPct(district.transitShare)}</text>`);
    parts.push("</g>");
  });
  parts.push("</svg>");
  return {
    html: parts.join("") + legend([
      { color: "#2d6d96", label: "公交" },
      { color: "#c7c2b5", label: "其他方式" }
    ]),
    title: "片区出行结构",
    subtitle: "公交 / 其他方式可相加 · 堆叠柱",
    warning: "",
    buttonHidden: true,
    buttonLabel: "",
    buttonPressed: false,
    ariaLabel: `片区出行结构堆叠柱，共 ${view.districts.length} 个片区。`
  };
}

export function buildChart(view, chapterId, stackAttempted) {
  if (chapterId === "speed") return speedChart(view, stackAttempted);
  if (chapterId === "transit") return transitChart(view);
  return flowChart(view);
}

export function buildMetrics(view, chapterId) {
  let metrics;
  if (chapterId === "speed") {
    metrics = [
      { label: "加权均速", value: formatSpeed(view.avgSpeed), unit: "km/h" },
      { label: "慢行走廊", value: formatNumber(view.congestedCount), unit: "低于 20 km/h" },
      { label: "观测对象", value: formatNumber(view.rowCount), unit: "条记录" }
    ];
  } else if (chapterId === "transit") {
    metrics = [
      { label: "公交人次", value: formatCompact(view.busRiders), unit: "人次/小时" },
      { label: "公交分担", value: formatPct(view.transitShare, 1), unit: "占全部流量" },
      { label: "观测对象", value: formatNumber(view.rowCount), unit: "条记录" }
    ];
  } else {
    metrics = [
      { label: "总流量", value: formatCompact(view.totalFlow), unit: "人次/小时" },
      { label: "入城占比", value: formatPct(view.inboundShare), unit: "当前筛选" },
      { label: "观测对象", value: formatNumber(view.rowCount), unit: "条记录" }
    ];
  }
  return metrics.map((metric) => (
    `<div class="metric-tile"><span>${escapeXml(metric.label)}</span><strong>${escapeXml(metric.value)}</strong><small>${escapeXml(metric.unit)}</small></div>`
  )).join("");
}

export function chapterById(chapterId) {
  return CHAPTERS.find((chapter) => chapter.id === chapterId) ?? CHAPTERS[0];
}
