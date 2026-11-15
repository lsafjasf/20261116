import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildExportManifest,
  buildNarrative,
  buildView,
  createProject,
  normalizeDataset,
  sanitizeFilters,
  stableHash,
  validateProject
} from "../js/core.js";

const base = JSON.parse(readFileSync("data/city-traffic-v1.json", "utf8"));
const audit = JSON.parse(readFileSync("data/city-traffic-v2-audit.json", "utf8"));
const allFilters = { districtId: "all", direction: "all", period: "all", recordScope: "clean" };

const normalize = (dataset) => normalizeDataset(structuredClone(dataset));
const viewFor = (dataset, processed, filters = allFilters) => buildView(dataset, processed, sanitizeFilters(filters));

test("fixed clean sample keeps all 160 rows and has no injected anomalies", () => {
  const processed = normalize(base);
  assert.equal(processed.rawCount, 160);
  assert.equal(processed.missingCount, 0);
  assert.equal(processed.duplicateCount, 0);
  assert.equal(processed.outlierCount, 0);
  assert.equal(processed.cleanCount, 160);
  assert.equal(processed.auditCount, 160);
  assert.equal(processed.anomalies.length, 0);
});

test("fixed audit sample removes nulls, duplicate IDs and outliers deterministically", () => {
  const processed = normalize(audit);
  assert.equal(processed.rawCount, 162);
  assert.equal(processed.missingCount, 3);
  assert.equal(processed.duplicateCount, 2);
  assert.equal(processed.outlierCount, 3);
  assert.equal(processed.cleanCount, 154);
  assert.equal(processed.auditCount, 159);
  assert.deepEqual(processed.anomalyCounts, { missing: 3, duplicate: 2, outlier: 3 });

  const cleanIds = processed.cleanRows.map((row) => row.id);
  assert.equal(new Set(cleanIds).size, cleanIds.length, "clean rows must have unique IDs");
  for (const row of processed.cleanRows) {
    assert.ok(Number.isFinite(row.flow));
    assert.ok(Number.isFinite(row.avgSpeed));
    assert.ok(Number.isFinite(row.busShare));
    assert.ok(row.busShare >= 0 && row.busShare <= 1);
    assert.ok(row.avgSpeed >= 2.5 && row.avgSpeed <= 80);
  }
  assert.equal(processed.auditRows.filter((row) => row._quality === "outlier").length, 3);
  assert.equal(processed.auditRows.filter((row) => row._quality === "duplicate").length, 2);
});

test("district, period and direction filters update aggregate counts and totals", () => {
  const processed = normalize(base);
  const district = viewFor(base, processed, { ...allFilters, districtId: "D1" });
  const morning = viewFor(base, processed, { ...allFilters, districtId: "D1", period: "am" });
  const inbound = viewFor(base, processed, { ...allFilters, districtId: "D1", period: "am", direction: "inbound" });

  assert.equal(district.rowCount, 60);
  assert.equal(morning.rowCount, 24);
  assert.equal(inbound.rowCount, 12);
  assert.equal(inbound.totalFlow, inbound.rows.reduce((total, row) => total + row.flow, 0));
  assert.equal(inbound.corridors.length, 3);
  assert.ok(inbound.avgSpeed > 0);
  assert.notEqual(inbound.dataHash, morning.dataHash);
});

test("narrative numbers change with the same filter state used by charts", () => {
  const processed = normalize(base);
  const allView = viewFor(base, processed);
  const westView = viewFor(base, processed, { ...allFilters, districtId: "D2", period: "pm" });
  const allNarrative = buildNarrative(allView, "flow", allView.filters);
  const westNarrative = buildNarrative(westView, "flow", westView.filters);

  assert.match(allNarrative.lede, /160 条观测/);
  assert.match(westNarrative.lede, /6 条观测/);
  assert.match(westNarrative.lede, /全部片区|西岸区/);
  assert.notEqual(allNarrative.summary, westNarrative.summary);
  assert.equal(westNarrative.metrics[0].value, String(westView.rowCount));
});

test("audit scope keeps countable anomalies while clean scope excludes them", () => {
  const processed = normalize(audit);
  const clean = viewFor(audit, processed, { ...allFilters, districtId: "D1", recordScope: "clean" });
  const auditView = viewFor(audit, processed, { ...allFilters, districtId: "D1", recordScope: "audit" });

  assert.equal(clean.rowCount, 58);
  assert.equal(auditView.rowCount, 60);
  assert.ok(auditView.totalFlow > clean.totalFlow);
  assert.ok(auditView.rows.every((row) => row.flow !== null && row.avgSpeed !== null && row.busShare !== null));
});

test("export manifest object count and key values match filtered view", () => {
  const processed = normalize(audit);
  const view = viewFor(audit, processed, { districtId: "D1", direction: "inbound", period: "am", recordScope: "clean" });
  const manifest = buildExportManifest(audit, processed, view, "speed");

  assert.equal(manifest.objectCount, view.rowCount);
  assert.equal(manifest.objectCount, view.rows.length);
  assert.equal(manifest.dataHash, view.dataHash);
  assert.deepEqual(manifest.keyValues, {
    totalFlow: Math.round(view.totalFlow),
    avgSpeed: view.avgSpeed,
    busRiders: Math.round(view.busRiders),
    transitShare: view.transitShare,
    corridorCount: view.corridors.length,
    topCorridor: view.topCorridor?.name ?? null
  });
  assert.equal(manifest.filterSummary, view.filterSummary);
  assert.equal(manifest.cleanObjectCount, processed.cleanCount);
});

test("saved project can be reloaded with data snapshot, filters and chapter state", () => {
  const processed = normalize(audit);
  const view = viewFor(audit, processed, { districtId: "D3", direction: "all", period: "pm", recordScope: "clean" });
  const settings = {
    ...view.filters,
    chapterId: "transit",
    noMotion: true,
    stackAttempted: true
  };
  const project = createProject(audit, settings, "测试工程");
  const roundTrip = validateProject(JSON.parse(JSON.stringify(project)));
  const reloadedProcessed = normalize(roundTrip.dataset);
  const reloadedView = viewFor(roundTrip.dataset, reloadedProcessed, roundTrip.settings);

  assert.equal(project.checksum, roundTrip.checksum);
  assert.equal(roundTrip.dataset.observations.length, audit.observations.length);
  assert.equal(roundTrip.settings.chapterId, "transit");
  assert.equal(roundTrip.settings.noMotion, true);
  assert.equal(roundTrip.settings.stackAttempted, true);
  assert.equal(reloadedView.rowCount, view.rowCount);
  assert.equal(reloadedView.totalFlow, view.totalFlow);
  assert.equal(reloadedView.dataHash, view.dataHash);
});

test("tampered project is rejected and hashes are stable", () => {
  const project = createProject(base, { ...allFilters, chapterId: "flow" });
  project.settings.districtId = "D4";
  assert.throws(() => validateProject(project), /校验和/);
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ b: 2, a: 1 }));
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
});

test("the committed demo project reloads to the same filtered report state", () => {
  const project = JSON.parse(readFileSync("data/demo-project.json", "utf8"));
  const valid = validateProject(project);
  const processed = normalize(valid.dataset);
  const view = viewFor(valid.dataset, processed, valid.settings);
  assert.equal(valid.schema, "city-pulse-project/v1");
  assert.equal(valid.checksum, "fnv1a-57e8e2c4");
  assert.equal(processed.rawCount, 162);
  assert.equal(processed.cleanCount, 154);
  assert.equal(view.rowCount, 154);
  assert.equal(view.filterSummary, "全部片区 · 全天 · 双向合计 · 仅清洗后记录");
});
