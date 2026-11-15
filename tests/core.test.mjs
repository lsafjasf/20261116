import test from "node:test";
import assert from "node:assert/strict";
import { boxesOverlap, normalizeSpec } from "../src/core.js";
import { buildChartLayout } from "../src/layout.js";
import { renderChartSVG } from "../src/svg.js";
import { SCENARIOS, chartToSpec } from "../src/scenarios.js";
import { verifyScenario } from "../src/state.js";

function allChartFrames() {
  return SCENARIOS.flatMap((scenario) =>
    scenario.charts.flatMap((chart) =>
      chart.frames.map((frame, frameIndex) => ({
        scenario,
        chart,
        frame,
        frameIndex,
        rendered: buildChartLayout(chartToSpec({ ...chart, selectedFrame: frameIndex }))
      }))
    )
  );
}

function textBoxes(layout) {
  const boxes = [];
  const add = (role, box) => {
    if (box) boxes.push({ role, box });
  };
  add("title", layout.header.title.bbox);
  add("subtitle", layout.header.subtitle?.bbox);
  for (const item of layout.legend.items) add(`legend:${item.name}`, item.bbox);
  for (const tick of layout.ticks.x) add(`tick-x:${tick.label}`, tick.bbox);
  for (const tick of layout.ticks.y) add(`tick-y:${tick.label}`, tick.bbox);
  for (const item of layout.annotations) add(`annotation:${item.text}`, item.bbox);
  add("axis-x", layout.axes.x?.bbox);
  add("axis-y", layout.axes.y?.bbox);
  add("empty", layout.emptyState?.bbox);
  return boxes;
}

test("three scenarios each contain three chart types and three keyframes", () => {
  assert.equal(SCENARIOS.length, 3);
  for (const scenario of SCENARIOS) {
    assert.equal(scenario.charts.length, 3);
    assert.ok(scenario.charts.every((chart) => chart.frames.length === 3));
    const types = new Set(scenario.charts.flatMap((chart) =>
      chart.frames[0].series.map((series) => series.type)
    ));
    assert.ok(types.has("line"));
    assert.ok(types.has("area"));
    assert.ok(types.has("scatter"));
  }
});

test("every layout frame has zero text-box overlap", () => {
  for (const { rendered, chart, frame } of allChartFrames()) {
    const boxes = textBoxes(rendered.layout);
    const collisions = [];
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        if (boxesOverlap(boxes[left].box, boxes[right].box, 0)) {
          collisions.push([boxes[left].role, boxes[right].role]);
        }
      }
    }
    assert.deepEqual(
      collisions,
      [],
      `${chart.id}/${frame.id} has overlapping labels: ${JSON.stringify(collisions)}`
    );
  }
});

test("missing values break line and area segments instead of drawing through gaps", () => {
  const layout = buildChartLayout({
    width: 600,
    height: 340,
    title: "gap",
    series: [
      {
        id: "gap-line",
        name: "gap-line",
        type: "line",
        data: [
          { x: 0, y: 1 },
          { x: 1, y: null },
          { x: 2, y: 3 },
          { x: 3, y: 4 },
          { x: 4, y: NaN },
          { x: 5, y: 6 }
        ]
      }
    ]
  });
  assert.equal(layout.layout.series[0].segments.length, 3);
  assert.equal(layout.layout.series[0].missing, 1);
  assert.equal(layout.layout.series[0].invalid, 1);
});

test("negative linear values render and non-positive log values are excluded", () => {
  const linear = buildChartLayout({
    width: 640,
    height: 360,
    title: "negative",
    series: [{
      id: "negative",
      name: "negative",
      type: "line",
      data: [{ x: 0, y: -20, label: "negative" }, { x: 1, y: 10 }, { x: 2, y: 0 }]
    }]
  });
  assert.ok(linear.layout.domains.y[0] < 0);
  assert.equal(linear.layout.series[0].points.length, 3);

  const logarithmic = buildChartLayout({
    width: 640,
    height: 360,
    title: "log",
    yAxis: { type: "log", tickCount: 6 },
    series: [{
      id: "log",
      name: "log",
      type: "area",
      data: [{ x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: -2 }, { x: 4, y: 100 }]
    }]
  });
  assert.ok(logarithmic.layout.domains.y[0] > 0);
  assert.equal(logarithmic.layout.series[0].points.length, 2);
  assert.ok(logarithmic.layout.ticks.y.every((tick) => tick.value > 0));
});

test("layout and SVG output are deterministic for reproducible exports", () => {
  for (const { chart, frameIndex } of allChartFrames()) {
    const input = chartToSpec({ ...chart, selectedFrame: frameIndex });
    const first = buildChartLayout(input);
    const second = buildChartLayout(input);
    assert.equal(first.layout.hash, second.layout.hash);
    const firstSvg = renderChartSVG(first.layout, first.spec, { idPrefix: chart.id });
    const secondSvg = renderChartSVG(second.layout, second.spec, { idPrefix: chart.id });
    assert.equal(firstSvg, secondSvg);
  }
});

test("SVG text coordinates match the shared layout", () => {
  const { rendered, chart } = allChartFrames()[0];
  const svg = renderChartSVG(rendered.layout, rendered.spec, { idPrefix: chart.id });
  for (const tick of [...rendered.layout.ticks.x, ...rendered.layout.ticks.y]) {
    const expectedX = tick.x.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    assert.match(svg, new RegExp(`data-role="tick-[xy]-label"`));
    assert.ok(svg.includes(`x="${expectedX}"`));
  }
  assert.ok(svg.includes(`data-layout-hash="${rendered.layout.hash}"`));
  assert.ok(svg.includes("data-role=\"legend-label\""));
  assert.ok(svg.includes("data-role=\"annotation-label\""));
});

test("anomalous parameters are normalized without throwing or blanking the scene", () => {
  const result = buildChartLayout({
    width: 40,
    height: 10,
    padding: 999,
    fontSize: 99,
    title: "异常参数",
    xAxis: { type: "time", domain: [10, -10], tickCount: 0 },
    yAxis: { type: "log", domain: [-10, 0], tickCount: 99 },
    series: [{
      id: "dirty",
      name: "dirty",
      type: "heatmap",
      color: "bad",
      data: [
        { x: 0, y: -1 },
        { x: 1, y: 0 },
        { x: 2, y: null },
        { x: 3, y: NaN },
        { x: 4, y: 100 },
        { x: 5, y: Infinity }
      ]
    }]
  });
  assert.equal(result.spec.width, 320);
  assert.equal(result.spec.height, 220);
  assert.equal(result.spec.xAxis.type, "linear");
  assert.ok(result.spec.padding < 64);
  assert.ok(result.warnings.length >= 4);
  assert.ok(result.layout.plot.width > 0);
  assert.ok(result.layout.plot.height > 0);
  assert.equal(result.layout.series[0].type, "line");
});

test("aggregate verification passes all 27 scenario/keyframe layouts", () => {
  for (const scenario of SCENARIOS) {
    const report = verifyScenario(scenario);
    assert.equal(report.pass, true);
    assert.equal(report.checkCount, 9);
    assert.equal(report.collisionCount, 0);
    assert.ok(report.pointCount > 0);
  }
});
