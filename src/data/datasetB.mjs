import { buildBaseRecords, applyAnomalies } from '../core/sample-builder.mjs';

const BASE_DATE = '2026-11-15';

const anomalies = {
  // 首尾空值 + 连续空值，覆盖断档在窗口边界的情形
  nulls: [
    ['S1', 0, 'tempC'], ['S1', 23, 'tempC'],
    ['S2', 12, 'precipMm'], ['S2', 13, 'precipMm'],
    ['S3', 7, 'windDirDeg'],
    ['S4', 18, 'tempC'], ['S4', 19, 'tempC'], ['S4', 20, 'tempC']
  ],
  outliers: [
    ['S3', 7, 'tempC', -55],      // 温度越下限
    ['S1', 15, 'precipMm', 260],  // 降水越上限
    ['S2', 4, 'windSpeedKmh', 240], // 风速越界
    ['S4', 11, 'cloudPct', 130]   // 云量越界
  ],
  duplicates: [
    // 重复记录修复了 S2 4 时的异常风速：保留最后一条后该点应恢复为有效值
    ['S2', 4, { windSpeedKmh: 12.5 }],
    ['S1', 6, { tempC: 11.2 }],
    ['S3', 22, {}],
    ['S4', 9, { windDirDeg: 275 }]
  ]
};

const base = buildBaseRecords(BASE_DATE, 2);
const rawRecords = applyAnomalies(base, BASE_DATE, anomalies, 2000);

export const datasetB = {
  id: 'B',
  name: '样例 B · 2026-11-15（含边界空值/重复修复/多量纲异常）',
  baseDate: BASE_DATE,
  version: 'sample-2026.11.16-v1/B',
  rawRecords,
  anomalyManifest: anomalies
};
