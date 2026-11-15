// 固定站点：x/y 为归一化地图坐标（0..1）
export const STATIONS = [
  { id: 'S1', name: '北岸', x: 0.22, y: 0.28 },
  { id: 'S2', name: '东港', x: 0.74, y: 0.20 },
  { id: 'S3', name: '西岭', x: 0.30, y: 0.68 },
  { id: 'S4', name: '南田', x: 0.68, y: 0.76 }
];

// 全部视图共享的时间窗口（小时下标，基于 24 个整点槽位 0..23）
// start 含、end 含；切换窗口后曲线刻度与地图时间范围使用同一份窗口对象
export const WINDOWS = {
  FULL:  { id: 'FULL',  label: '全天 0–23 时', start: 0,  end: 23 },
  AM:    { id: 'AM',    label: '上午 0–11 时', start: 0,  end: 11 },
  PM:    { id: 'PM',    label: '下午 12–23 时', start: 12, end: 23 },
  Q1:    { id: 'Q1',    label: '凌晨 0–5 时',  start: 0,  end: 5 },
  Q2:    { id: 'Q2',    label: '上午 6–11 时', start: 6,  end: 11 },
  Q3:    { id: 'Q3',    label: '下午 12–17 时', start: 12, end: 17 },
  Q4:    { id: 'Q4',    label: '夜间 18–23 时', start: 18, end: 23 }
};

// 合理量纲范围，越界视为异常值并隔离（不参与插值/连线/统计）
export const VALID_RANGE = {
  tempC: [-40, 50],
  precipMm: [0, 200],
  windDirDeg: [0, 360],
  windSpeedKmh: [0, 150],
  cloudPct: [0, 100]
};

export const VARIABLES = {
  tempC: { label: '温度', unit: '°C' },
  precipMm: { label: '降水', unit: 'mm' },
  windDirDeg: { label: '风向', unit: '°' }
};

export const DATA_VERSION = 'sample-2026.11.16-v1';
export const EXPORT_SPEC = 'meteo-timeline-report/v1';
