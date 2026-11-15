export const DAMAGE_TYPES = {
  hum: {
    id: "hum",
    label: "窄带嗡鸣",
    short: "50 Hz 电源嗡鸣",
    detail: "持续低频正弦叠加，人声底噪被掩蔽",
    channel: "audio"
  },
  drop: {
    id: "drop",
    label: "抽帧缺损",
    short: "连续视频帧缺失",
    detail: "运动矢量断裂，需要依据前后帧重建中间画面",
    channel: "video"
  },
  grain: {
    id: "grain",
    label: "高感噪点",
    short: "暗部颗粒噪声",
    detail: "低照度增益噪声，时域随机闪烁明显",
    channel: "video"
  },
  drift: {
    id: "drift",
    label: "音画漂移",
    short: "声画时间轴错位",
    detail: "音频相对画面存在固定偏移，需要重新对齐",
    channel: "sync"
  }
};

export const TOOLS = [
  {
    id: "denoise",
    damage: "hum",
    domain: "audio",
    order: 1,
    short: "去噪",
    label: "频谱去噪",
    icon: "≈",
    desc: "锁定 50 Hz 谐波并重建被掩蔽的声场",
    parameter: "衰减强度",
    unit: "%",
    min: 20,
    max: 95,
    hardMin: 0,
    hardMax: 100,
    default: 68,
    ideal: 68,
    costCpu: 38,
    costMemory: 36,
    duration: 1.55
  },
  {
    id: "interpolate",
    damage: "drop",
    domain: "video",
    order: 2,
    short: "补帧",
    label: "光流补帧",
    icon: "◫",
    desc: "根据前后光流重建缺失帧，修复运动连续性",
    parameter: "补偿帧数",
    unit: "帧",
    min: 1,
    max: 4,
    hardMin: 1,
    hardMax: 8,
    default: 2,
    ideal: 2,
    costCpu: 46,
    costMemory: 52,
    duration: 1.85
  },
  {
    id: "reduceNoise",
    damage: "grain",
    domain: "video",
    order: 3,
    short: "降噪",
    label: "时域降噪",
    icon: "▧",
    desc: "在保留边缘的前提下抑制暗部随机颗粒",
    parameter: "降噪阈值",
    unit: "%",
    min: 20,
    max: 90,
    hardMin: 0,
    hardMax: 100,
    default: 58,
    ideal: 58,
    costCpu: 42,
    costMemory: 58,
    duration: 1.65
  },
  {
    id: "align",
    damage: "drift",
    domain: "sync",
    order: 4,
    short: "对齐",
    label: "重新时间对齐",
    icon: "⇆",
    desc: "以打板脉冲为锚点平移音轨，恢复口型同步",
    parameter: "音轨偏移",
    unit: "ms",
    min: -400,
    max: 400,
    hardMin: -500,
    hardMax: 500,
    default: 0,
    ideal: 0,
    costCpu: 30,
    costMemory: 24,
    duration: 1.35
  }
];

export const SAMPLES = [
  {
    id: "rain-shed",
    code: "RAIN-017",
    title: "雨棚 · 17:42",
    subtitle: "街区监控 B / 暴雨夜",
    duration: 42,
    seed: 17042,
    driftMs: 120,
    damage: ["hum", "drop", "grain", "drift"],
    missingFrames: [5, 6],
    grainFrames: [2, 3, 7, 10],
    humLevel: 0.42,
    palette: ["#c8ff5a", "#65d8c7", "#ffb168"],
    location: "BLOCK 07 / CAM-B",
    incident: "自动售货机玻璃破裂，嫌疑人由东侧楼梯离开",
    footage: "雨棚下方 42 秒连续录像，含 2 帧硬缺失",
    evidence: "本段素材是唯一记录到嫌疑人步态的画面",
    tags: ["雨棚", "监控", "步态", "玻璃破裂"],
    frameSeed: 17,
    accent: "#c8ff5a"
  },
  {
    id: "pier",
    code: "PIER-044",
    title: "旧码头 · 04:11",
    subtitle: "手持记录仪 / 海雾",
    duration: 36,
    seed: 44011,
    driftMs: -86,
    damage: ["hum", "drop", "drift"],
    missingFrames: [7],
    grainFrames: [],
    humLevel: 0.33,
    palette: ["#ffb168", "#7bb9ff", "#f1e5c7"],
    location: "SOUTH PIER / UNIT 3",
    incident: "货柜吊机异常启动，现场出现短暂电弧",
    footage: "手持记录仪 36 秒，帧 07 冻结，音轨提前 86 ms",
    evidence: "电弧闪光与吊机控制口令在同一时窗出现",
    tags: ["码头", "电弧", "吊机", "口令"],
    frameSeed: 44,
    accent: "#ffb168"
  },
  {
    id: "metro",
    code: "METR-203",
    title: "地下站 · 23:06",
    subtitle: "站台广角 / 应急照明",
    duration: 51,
    seed: 20306,
    driftMs: 215,
    damage: ["grain", "drift"],
    missingFrames: [],
    grainFrames: [1, 4, 5, 8, 9, 11],
    humLevel: 0.12,
    palette: ["#7bb9ff", "#d2a8ff", "#c8ff5a"],
    location: "METRO L2 / PLATFORM 4",
    incident: "末班车离站后，检修门发生非授权开启",
    footage: "站台广角 51 秒，高感噪点严重，声画漂移 215 ms",
    evidence: "检修门开启前后的环境声仍在可用频段",
    tags: ["地铁", "检修门", "广角", "环境声"],
    frameSeed: 203,
    accent: "#7bb9ff"
  }
];

export function getSample(id) {
  return SAMPLES.find((sample) => sample.id === id) || SAMPLES[0];
}

export function getTool(id) {
  return TOOLS.find((tool) => tool.id === id) || null;
}

export function getDamage(id) {
  return DAMAGE_TYPES[id] || null;
}

export function formatTimecode(seconds, withFrames = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const hh = String(Math.floor(whole / 3600)).padStart(2, "0");
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  if (!withFrames) return `${hh}:${mm}:${ss}`;
  const ff = String(Math.floor((safe % 1) * 25)).padStart(2, "0");
  return `${hh}:${mm}:${ss}:${ff}`;
}

export function formatDuration(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  return `${safe.toFixed(1)}s`;
}
