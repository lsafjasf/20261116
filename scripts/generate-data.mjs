import { mkdirSync, writeFileSync } from "node:fs";
import { stableHash } from "../js/core.js";

const districts = [
  { id: "D1", name: "中心城", center: [316, 246], tone: "#e65a3c" },
  { id: "D2", name: "西岸区", center: [148, 298], tone: "#147c75" },
  { id: "D3", name: "东港区", center: [492, 192], tone: "#2e6f9e" },
  { id: "D4", name: "南站新区", center: [396, 410], tone: "#9a6b2f" },
  { id: "D5", name: "北山片区", center: [238, 93], tone: "#6e5a8e" }
];

const corridors = [
  { id: "C01", name: "滨江大道", districtId: "D1", capacity: 42000, baseSpeed: 35, factor: 1.02, path: [[70, 225], [180, 238], [320, 225], [455, 205]] },
  { id: "C02", name: "中山路", districtId: "D1", capacity: 38000, baseSpeed: 30, factor: 1.08, path: [[120, 315], [260, 320], [400, 305], [520, 290]] },
  { id: "C03", name: "北环高架", districtId: "D5", capacity: 44000, baseSpeed: 48, factor: 0.92, path: [[90, 115], [215, 90], [350, 102], [455, 135]] },
  { id: "C04", name: "科创大道", districtId: "D2", capacity: 32000, baseSpeed: 32, factor: 1.04, path: [[70, 330], [140, 280], [205, 245], [300, 225]] },
  { id: "C05", name: "港区联络线", districtId: "D3", capacity: 30000, baseSpeed: 38, factor: 0.96, path: [[470, 110], [505, 175], [480, 245], [450, 290]] },
  { id: "C06", name: "南站大道", districtId: "D4", capacity: 36000, baseSpeed: 34, factor: 1.05, path: [[330, 430], [395, 405], [465, 365], [520, 330]] },
  { id: "C07", name: "山麓路", districtId: "D5", capacity: 27000, baseSpeed: 28, factor: 0.86, path: [[160, 180], [205, 230], [250, 300], [280, 360]] },
  { id: "C08", name: "跨江大桥", districtId: "D1", capacity: 40000, baseSpeed: 40, factor: 0.98, path: [[300, 225], [350, 260], [405, 280], [455, 290]] }
];

const hours = [6, 7, 8, 9, 12, 17, 18, 19, 22, 23];
const hourFactor = { 6: 0.52, 7: 0.9, 8: 1.02, 9: 0.72, 12: 0.55, 17: 0.82, 18: 1.06, 19: 0.9, 22: 0.3, 23: 0.18 };
const round10 = (value) => Math.round(value / 10) * 10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function observationsFor(version) {
  const rows = [];
  let index = 0;
  for (const corridor of corridors) {
    for (const hour of hours) {
      for (const direction of ["inbound", "outbound"]) {
        index += 1;
        const isMorningPeak = hour >= 7 && hour <= 9;
        const isEveningPeak = hour >= 17 && hour <= 19;
        const directionFactor = isMorningPeak
          ? (direction === "inbound" ? 1.16 : 0.84)
          : isEveningPeak
            ? (direction === "outbound" ? 1.18 : 0.82)
            : 0.97;
        const wave = Math.sin(index * 1.7) * 0.025;
        const flow = round10(corridor.capacity * hourFactor[hour] * directionFactor * (corridor.factor + wave));
        const load = flow / corridor.capacity;
        const speedWave = Math.cos(index * 0.83) * 1.6;
        const avgSpeed = Number(clamp(corridor.baseSpeed - load * corridor.baseSpeed * 0.52 + speedWave, 8, 62).toFixed(1));
        const peakBoost = isMorningPeak || isEveningPeak ? 0.07 : 0;
        const busShare = Number(clamp(0.27 + peakBoost + Math.sin(index * 0.51) * 0.035, 0.22, 0.48).toFixed(3));
        rows.push({
          id: `LT-W46-${String(index).padStart(4, "0")}`,
          corridorId: corridor.id,
          districtId: corridor.districtId,
          hour,
          direction,
          flow,
          avgSpeed,
          busShare,
          incidentCount: index % 23 === 0 ? 1 : 0,
          observedAt: `2026-11-${String(9 + (index % 7)).padStart(2, "0")}T${String(hour).padStart(2, "0")}:15:00+08:00`,
          quality: "valid"
        });
      }
    }
  }
  return rows.map((row) => ({ ...row, datasetVersion: version }));
}

const base = {
  schema: "city-pulse-dataset/v1",
  id: "linjiang-base",
  city: "临江市",
  version: "LT-2026.11-A",
  title: "临江市综合交通观测周报",
  releasedAt: "2026-11-15T18:00:00+08:00",
  period: { from: "2026-11-09", to: "2026-11-15" },
  units: { flow: "人次/小时", speed: "公里/小时", share: "占比" },
  notes: "基线样例：八条走廊、十个观测时段、双方向。",
  districts,
  corridors,
  observations: observationsFor("LT-2026.11-A")
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const audit = clone(base);
audit.id = "linjiang-audit";
audit.version = "LT-2026.11-B";
audit.title = "临江市综合交通观测周报（审计样例）";
audit.releasedAt = "2026-11-15T22:30:00+08:00";
audit.notes = "审计样例：保留原始行，并注入空值、重复记录和异常值供清洗验证。";

const obs = audit.observations;
obs[10] = { ...obs[10], flow: null, quality: "missing" };
obs[43] = { ...obs[43], avgSpeed: null, quality: "missing" };
obs[91] = { ...obs[91], busShare: null, quality: "missing" };
obs.push({ ...obs[20], quality: "duplicate" });
obs.push({ ...obs[70], quality: "duplicate" });
obs[25] = { ...obs[25], flow: 98000, quality: "outlier" };
obs[60] = { ...obs[60], avgSpeed: 1.4, quality: "outlier" };
obs[100] = { ...obs[100], busShare: 1.4, quality: "outlier" };

audit.anomalies = [
  { type: "null", rowId: obs[10].id, field: "flow", note: "流量为空" },
  { type: "null", rowId: obs[43].id, field: "avgSpeed", note: "平均速度为空" },
  { type: "null", rowId: obs[91].id, field: "busShare", note: "公交分担率为空" },
  { type: "duplicate", rowId: obs[160].id, field: "id", note: "重复追加的观测行" },
  { type: "duplicate", rowId: obs[161].id, field: "id", note: "重复追加的观测行" },
  { type: "outlier", rowId: obs[25].id, field: "flow", note: "流量 98,000 超出上限 84,000" },
  { type: "outlier", rowId: obs[60].id, field: "avgSpeed", note: "速度 1.4 低于城市路网下限" },
  { type: "outlier", rowId: obs[100].id, field: "busShare", note: "公交分担率 1.4 超出 0–1" }
];

const projectSettings = {
  districtId: "all",
  direction: "all",
  period: "all",
  recordScope: "clean",
  chapterId: "flow",
  noMotion: false,
  stackAttempted: false
};

const project = {
  schema: "city-pulse-project/v1",
  name: "临江市 · 审计报道工程",
  savedAt: "2026-11-16T09:30:00+08:00",
  dataset: audit,
  settings: projectSettings
};
project.checksum = stableHash({
  datasetVersion: audit.version,
  datasetId: audit.id,
  settings: projectSettings
});

mkdirSync("data", { recursive: true });
writeFileSync("data/city-traffic-v1.json", `${JSON.stringify(base, null, 2)}\n`);
writeFileSync("data/city-traffic-v2-audit.json", `${JSON.stringify(audit, null, 2)}\n`);
writeFileSync("data/demo-project.json", `${JSON.stringify(project, null, 2)}\n`);

console.log(`base: ${base.observations.length} rows`);
console.log(`audit: ${audit.observations.length} raw rows, ${audit.anomalies.length} injected anomalies`);
