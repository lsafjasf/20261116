import { buildBaseRecords, applyAnomalies } from '../core/sample-builder.mjs';

const BASE_DATE = '2026-11-14';

const anomalies = {
  // 含连续空值（S1 温度 5、6 时），曲线必须断开，禁止用连线伪造
  nulls: [
    ['S1', 5, 'tempC'], ['S1', 6, 'tempC'],
    ['S2', 10, 'precipMm'],
    ['S3', 16, 'tempC'],
    ['S4', 20, 'windDirDeg'], ['S4', 21, 'windDirDeg']
  ],
  outliers: [
    ['S2', 10, 'tempC', 99.4],      // 温度越上限
    ['S3', 16, 'precipMm', 305],    // 降水越上限
    ['S1', 20, 'windDirDeg', 420],  // 风向越界
    ['S4', 3, 'precipMm', -8]       // 降水为负
  ],
  duplicates: [
    ['S1', 8, { tempC: 19.9 }],     // 重复且改值，以最后一条为准
    ['S3', 12, {}],                 // 完全重复，仅去重计数
    ['S4', 2, { precipMm: 1.1 }]
  ]
};

const base = buildBaseRecords(BASE_DATE, 1);
const rawRecords = applyAnomalies(base, BASE_DATE, anomalies, 1000);

export const datasetA = {
  id: 'A',
  name: '样例 A · 2026-11-14（含连续空值/重复/越界）',
  baseDate: BASE_DATE,
  version: 'sample-2026.11.16-v1/A',
  rawRecords,
  anomalyManifest: anomalies
};
