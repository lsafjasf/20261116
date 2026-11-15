import {
  axisTicks,
  boxesAreClear,
  calculateDomains,
  clamp,
  estimateTextWidth,
  fitText,
  makeScale,
  normalizeSpec,
  pointSegments,
  round,
  summarizeSeries,
  textBox
} from "./core.js";

function legendItems(spec, fontSize) {
  const compact = spec.width < 440 || spec.height < 340;
  const maxText = compact
    ? Math.max(36, Math.floor(
        (spec.width - spec.padding * 2) / Math.max(1, Math.min(spec.series.length, 3))
      ) - 38)
    : spec.width - spec.padding * 2 - 34;
  return spec.series.map((series) => {
    const name = fitText(series.name, maxText, fontSize, 600);
    const textWidth = estimateTextWidth(name, fontSize, 600);
    return {
      id: series.id,
      name,
      color: series.color,
      type: series.type,
      textWidth,
      width: 16 + textWidth + 18,
      height: fontSize + 12
    };
  });
}

function packLegend(items, x, y, maxWidth, rightAlign, totalWidth) {
  const rows = [];
  let row = [];
  let width = 0;
  for (const item of items) {
    if (row.length && width + item.width > maxWidth) {
      rows.push({ items: row, width });
      row = [];
      width = 0;
    }
    row.push(item);
    width += item.width;
  }
  if (row.length) rows.push({ items: row, width });

  const result = [];
  let cursorY = y;
  for (const legendRow of rows) {
    let cursorX = rightAlign ? x + maxWidth - legendRow.width : x;
    if (!rightAlign && totalWidth > maxWidth) cursorX = x;
    for (const item of legendRow.items) {
      const bbox = {
        x: cursorX,
        y: cursorY,
        width: item.width,
        height: item.height
      };
      result.push({
        ...item,
        x: cursorX,
        y: cursorY,
        markerX: cursorX + 6,
        markerY: cursorY + item.height / 2,
        textX: cursorX + 16,
        textY: cursorY + item.height / 2,
        bbox
      });
      cursorX += item.width;
    }
    cursorY += legendRow.items[0].height + 4;
  }
  return { items: result, rows, width: Math.max(0, ...rows.map((row) => row.width)), bottom: cursorY };
}

function layoutLegend(spec, titleBoxes, fontSize) {
  const items = legendItems(spec, fontSize);
  if (!items.length) return { items: [], bottom: spec.padding + 10, mode: "none" };
  const pad = spec.padding;
  const totalWidth = items.reduce((sum, item) => sum + item.width, 0);
  const titleRight = Math.max(...titleBoxes.map((box) => box.x + box.width), pad + 200);
  const sideWidth = spec.width - pad * 2 - (titleRight - pad) - 24;
  const sideEligible = sideWidth >= 190 && Math.max(...items.map((item) => item.width)) <= sideWidth;
  if (sideEligible) {
    const packed = packLegend(items, titleRight + 24, pad - 3, sideWidth, true, totalWidth);
    const collides = packed.items.some((item) =>
      titleBoxes.some((box) => {
        return !(
          item.bbox.x + item.bbox.width <= box.x ||
          box.x + box.width <= item.bbox.x ||
          item.bbox.y + item.bbox.height <= box.y ||
          box.y + box.height <= item.bbox.y
        );
      })
    );
    if (!collides) return { ...packed, mode: "top-right" };
  }
  const headerBottom = Math.max(...titleBoxes.map((box) => box.y + box.height), pad);
  const packed = packLegend(items, pad, headerBottom + 10, spec.width - pad * 2, false, totalWidth);
  return { ...packed, mode: "below-title" };
}

function buildYTicks(domain, axis, plot, fontSize) {
  const scale = makeScale(axis, domain, [plot.y + plot.height, plot.y]);
  const candidates = axisTicks(axis, domain)
    .map((tick) => {
      const cy = scale(tick.value);
      return {
        ...tick,
        x: plot.x - 10,
        y: cy,
        cy,
        font: fontSize,
        anchor: "end",
        bbox: textBox(tick.label, plot.x - 10, cy, { fontSize, anchor: "end" })
      };
    })
    .filter((tick) => Number.isFinite(tick.cy) && tick.cy >= plot.y - 1 && tick.cy <= plot.y + plot.height + 1);

  const accepted = [];
  for (const tick of candidates) {
    if (boxesAreClear(tick.bbox, accepted.map((item) => item.bbox), 1)) accepted.push(tick);
  }
  return accepted;
}

function buildXTicks(domain, axis, plot, fontSize) {
  const scale = makeScale(axis, domain, [plot.x, plot.x + plot.width]);
  const candidates = axisTicks(axis, domain).map((tick) => {
    const x = scale(tick.value);
    let anchor = "middle";
    if (x < plot.x + 18) anchor = "start";
    if (x > plot.x + plot.width - 18) anchor = "end";
    return {
      ...tick,
      x,
      y: plot.y + plot.height + 18,
      font: fontSize,
      anchor,
      bbox: textBox(tick.label, x, plot.y + plot.height + 18, { fontSize, anchor })
    };
  }).filter((tick) => Number.isFinite(tick.x) && tick.x >= plot.x - 2 && tick.x <= plot.x + plot.width + 2);

  const accepted = [];
  for (const tick of candidates) {
    if (tick.bbox.x < 2 || tick.bbox.x + tick.bbox.width > plot.x + plot.width + 4) continue;
    if (boxesAreClear(tick.bbox, accepted.map((item) => item.bbox), 4)) accepted.push(tick);
  }
  return accepted;
}

function buildHeader(spec, fontSize) {
  const titleSize = clamp(fontSize + 8, 16, 26);
  const titleCy = spec.padding + titleSize * 0.58;
  const titleText = fitText(spec.title, spec.width - spec.padding * 2, titleSize, 750);
  const title = {
    text: titleText,
    x: spec.padding,
    y: titleCy,
    fontSize: titleSize,
    weight: 750,
    anchor: "start",
    bbox: textBox(titleText, spec.padding, titleCy, {
      fontSize: titleSize,
      weight: 750,
      anchor: "start"
    })
  };
  const subtitleCy = titleCy + titleSize * 0.78 + fontSize * 0.78;
  const subtitleText = fitText(spec.subtitle, spec.width - spec.padding * 2, fontSize, 500);
  const subtitle = spec.subtitle
    ? {
        text: subtitleText,
        x: spec.padding,
        y: subtitleCy,
        fontSize,
        weight: 500,
        anchor: "start",
        bbox: textBox(subtitleText, spec.padding, subtitleCy, {
          fontSize,
          weight: 500,
          anchor: "start"
        })
      }
    : null;
  return {
    title,
    subtitle,
    boxes: subtitle ? [title.bbox, subtitle.bbox] : [title.bbox],
    bottom: subtitle ? subtitle.bbox.y + subtitle.bbox.height : title.bbox.y + title.bbox.height
  };
}

function pathForSegment(segment) {
  return segment.map((point, index) => `${index ? "L" : "M"}${round(point.px)} ${round(point.py)}`).join(" ");
}

function areaPathForSegment(segment, baseline) {
  if (!segment.length) return "";
  const first = segment[0];
  const last = segment[segment.length - 1];
  return `M${round(first.px)} ${round(baseline)} ${segment
    .map((point) => `L${round(point.px)} ${round(point.py)}`)
    .join(" ")} L${round(last.px)} ${round(baseline)} Z`;
}

function buildSeriesGeometry(spec, domains, plot) {
  const xScale = makeScale(spec.xAxis, domains.x, [plot.x, plot.x + plot.width]);
  const yScale = makeScale(spec.yAxis, domains.y, [plot.y + plot.height, plot.y]);
  const includesZero = domains.y[0] <= 0 && domains.y[1] >= 0;
  const allY = spec.series.flatMap((series) =>
    series.points.filter((point) => point.x != null && point.y != null).map((point) => point.y)
  );
  const baseline = includesZero
    ? yScale(0)
    : allY.every((value) => value >= 0)
      ? plot.y + plot.height
      : plot.y;
  return spec.series.map((series) => {
    const segments = pointSegments(series).map((rawSegment) => {
      const points = rawSegment.map((point) => ({
        ...point,
        px: xScale(point.x),
        py: yScale(point.y)
      }));
      return { points, line: pathForSegment(points), area: areaPathForSegment(points, baseline) };
    });
    return {
      id: series.id,
      name: series.name,
      type: series.type,
      color: series.color,
      opacity: series.opacity,
      missing: series.missing,
      invalid: series.invalid,
      segments,
      points: segments.flatMap((segment) => segment.points)
    };
  });
}

function annotationCandidates(point, text, fontSize, radius) {
  const gap = 8;
  const width = estimateTextWidth(text, fontSize, 600) + 10;
  const height = fontSize + 9;
  const centerY = point.py - radius - gap - height / 2;
  const sideY = point.py;
  return [
    { textX: point.px, textY: centerY, anchor: "middle" },
    { textX: point.px + radius + gap, textY: sideY, anchor: "start" },
    { textX: point.px - radius - gap, textY: sideY, anchor: "end" },
    { textX: point.px, textY: point.py + radius + gap + height / 2, anchor: "middle" },
    { textX: point.px + radius + gap, textY: point.py - radius - gap, anchor: "start" },
    { textX: point.px - radius - gap, textY: point.py - radius - gap, anchor: "end" },
    { textX: point.px + radius + gap, textY: point.py + radius + gap, anchor: "start" },
    { textX: point.px - radius - gap, textY: point.py + radius + gap, anchor: "end" },
    { textX: point.px, textY: point.py - radius - gap - height * 1.5, anchor: "middle" },
    { textX: point.px + width * 0.72, textY: centerY - height, anchor: "middle" },
    { textX: point.px - width * 0.72, textY: centerY - height, anchor: "middle" },
    { textX: point.px, textY: point.py + radius + gap + height * 1.55, anchor: "middle" }
  ];
}

function buildAnnotations(seriesGeometry, occupied, plot, fontSize) {
  const annotations = [];
  let skipped = 0;
  const annotationFont = Math.max(10, fontSize - 1);
  for (const series of seriesGeometry) {
    for (const point of series.points) {
      if (!point.label) continue;
      const radius = point.radius ?? 4;
      let placed = null;
      for (const candidate of annotationCandidates(point, point.label, annotationFont, radius)) {
        const box = textBox(point.label, candidate.textX, candidate.textY, {
          fontSize: annotationFont,
          weight: 600,
          anchor: candidate.anchor,
          padX: 5,
          padY: 4
        });
        const inside = box.x >= 3 &&
          box.y >= 3 &&
          box.x + box.width <= plot.x + plot.width + 6 &&
          box.y + box.height <= plot.y + plot.height + 6;
        if (!inside || !boxesAreClear(box, [...occupied, ...annotations.map((item) => item.bbox)], 3)) {
          continue;
        }
        const leaderX = candidate.anchor === "start"
          ? box.x
          : candidate.anchor === "end"
            ? box.x + box.width
            : box.x + box.width / 2;
        const leaderY = clamp(point.py, box.y + 3, box.y + box.height - 3);
        placed = {
          seriesId: series.id,
          color: series.color,
          text: point.label,
          textX: candidate.textX,
          textY: candidate.textY,
          anchor: candidate.anchor,
          fontSize: annotationFont,
          bbox: box,
          point: { x: point.px, y: point.py },
          leader: { x1: point.px, y1: point.py, x2: leaderX, y2: leaderY }
        };
        break;
      }
      if (placed) annotations.push(placed);
      else skipped += 1;
    }
  }
  return { annotations, skipped };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(value) {
  const source = typeof value === "string" ? value : stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildChartLayout(input = {}) {
  const spec = normalizeSpec(input);
  const fontSize = clamp(spec.fontSize, 10, 14);
  const header = buildHeader(spec, fontSize);
  const legend = layoutLegend(spec, header.boxes, fontSize);
  const domains = calculateDomains(spec);
  const tickFont = Math.max(9, fontSize - 1);
  const yCandidates = axisTicks(spec.yAxis, domains.y);
  const widestYLabel = Math.max(
    0,
    ...yCandidates.map((tick) => estimateTextWidth(tick.label, tickFont, 500))
  );
  const axisLabelRoom = spec.yLabel ? 24 : 0;
  const plotLeft = clamp(
    spec.padding + widestYLabel + axisLabelRoom + 20,
    spec.padding + 36,
    spec.width * 0.46
  );
  const preferredPlotTop = Math.max(
    header.bottom + 20,
    legend.mode === "below-title" ? legend.bottom + 12 : 0,
    70
  );
  const xBottomRoom = spec.xLabel ? 48 : 31;
  const availableBottom = spec.height - spec.padding - xBottomRoom;
  const plotTop = Math.max(54, Math.min(preferredPlotTop, availableBottom - 38));
  const plotBottom = Math.max(plotTop + 38, availableBottom);
  const plot = {
    x: round(plotLeft),
    y: round(plotTop),
    width: round(Math.max(40, spec.width - spec.padding - plotLeft)),
    height: round(Math.max(38, Math.min(plotBottom, spec.height - spec.padding - 20) - plotTop))
  };
  plot.bottom = round(plot.y + plot.height);
  const xTicks = buildXTicks(domains.x, spec.xAxis, plot, tickFont);
  const yTicks = buildYTicks(domains.y, spec.yAxis, plot, tickFont);
  const xAxisLabel = spec.xLabel
    ? {
        text: fitText(spec.xLabel, Math.max(40, plot.width - 16), tickFont, 500),
        x: round(plot.x + plot.width / 2),
        y: round(spec.height - spec.padding),
        fontSize: tickFont,
        anchor: "middle",
        bbox: textBox(fitText(spec.xLabel, Math.max(40, plot.width - 16), tickFont, 500), plot.x + plot.width / 2, spec.height - spec.padding, {
          fontSize: tickFont,
          anchor: "middle"
        })
      }
    : null;
  const yAxisLabel = spec.yLabel
    ? {
        text: fitText(spec.yLabel, Math.max(36, plot.height - 6), tickFont, 500),
        x: round(spec.padding + tickFont * 0.82),
        y: round(plot.y + plot.height / 2),
        fontSize: tickFont,
        anchor: "middle",
        bbox: {
          x: spec.padding,
          y: plot.y + plot.height / 2 - estimateTextWidth(fitText(spec.yLabel, Math.max(36, plot.height - 6), tickFont, 500), tickFont, 500) / 2,
          width: tickFont + 3,
          height: estimateTextWidth(fitText(spec.yLabel, Math.max(36, plot.height - 6), tickFont, 500), tickFont, 500)
        }
      }
    : null;
  const series = buildSeriesGeometry(spec, domains, plot);
  const labels = [...header.boxes, ...legend.items.map((item) => item.bbox)];
  if (xAxisLabel) labels.push(xAxisLabel.bbox);
  if (yAxisLabel) labels.push(yAxisLabel.bbox);
  const textOccupied = [
    ...labels,
    ...xTicks.map((tick) => tick.bbox),
    ...yTicks.map((tick) => tick.bbox)
  ];
  const { annotations, skipped } = buildAnnotations(series, textOccupied, plot, fontSize);
  const warnings = [...spec.warnings];
  if (skipped) warnings.push(`${skipped} 个点标注因空间不足已隐藏，避免文字重叠`);
  if (!series.some((item) => item.points.length)) warnings.push("没有可绘制的有效数据点");
  const emptyState = !series.some((item) => item.points.length)
    ? {
        text: "无有效数据点 · 已跳过空值与非正值",
        x: round(plot.x + plot.width / 2),
        y: round(plot.y + plot.height / 2),
        fontSize: tickFont,
        anchor: "middle",
        bbox: textBox("无有效数据点 · 已跳过空值与非正值", plot.x + plot.width / 2, plot.y + plot.height / 2, {
          fontSize: tickFont,
          anchor: "middle",
          padX: 8,
          padY: 6
        })
      }
    : null;

  const layout = {
    width: spec.width,
    height: spec.height,
    padding: spec.padding,
    background: spec.background,
    fontFamily: spec.fontFamily,
    fontSize,
    layerOrder: spec.layerOrder,
    plot,
    domains,
    header,
    legend,
    ticks: { x: xTicks, y: yTicks },
    axes: { x: xAxisLabel, y: yAxisLabel },
    series,
    annotations,
    emptyState,
    labels: textOccupied,
    warnings,
    summary: spec.series.map(summarizeSeries),
    skippedAnnotations: skipped
  };
  layout.hash = stableHash({
    width: layout.width,
    height: layout.height,
    plot: layout.plot,
    domains: layout.domains,
    ticks: layout.ticks,
    legend: layout.legend.items.map((item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      width: item.width
    })),
    series: layout.series.map((item) => ({
      id: item.id,
      color: item.color,
      segments: item.segments.map((segment) => segment.points.map((point) => [round(point.px), round(point.py)]))
    })),
    annotations: layout.annotations.map((item) => ({
      text: item.text,
      x: item.textX,
      y: item.textY,
      bbox: item.bbox
    }))
  });
  return { spec, layout, warnings };
}

export function snapshotCoordinates(layout) {
  return {
    plot: layout.plot,
    points: layout.series.flatMap((series) =>
      series.points.map((point) => ({
        seriesId: series.id,
        x: round(point.px),
        y: round(point.py),
        dataX: point.x,
        dataY: point.y
      }))
    ),
    legend: layout.legend.items.map((item) => ({
      id: item.id,
      x: round(item.x),
      y: round(item.y),
      color: item.color
    })),
    ticks: {
      x: layout.ticks.x.map((tick) => ({ value: tick.value, x: round(tick.x), y: round(tick.y) })),
      y: layout.ticks.y.map((tick) => ({ value: tick.value, x: round(tick.x), y: round(tick.y) }))
    }
  };
}
