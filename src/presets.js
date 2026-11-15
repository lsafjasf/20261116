// 三组可视化对照天气参数（晴 / 阴湿 / 风暴），同一份地形与相机基准。
export const WEATHER_PRESETS = Object.freeze({
  clear: {
    id: 'clear',
    label: '晴朗微风',
    windSpeed: 3,
    windDir: 35,
    humidity: 0.14,
    sunAzimuth: 130,
    sunElevation: 48,
  },
  humid: {
    id: 'humid',
    label: '阴湿浓雾',
    windSpeed: 9,
    windDir: 210,
    humidity: 0.66,
    sunAzimuth: 250,
    sunElevation: 18,
  },
  storm: {
    id: 'storm',
    label: '风暴急流',
    windSpeed: 26,
    windDir: 170,
    humidity: 0.9,
    sunAzimuth: 300,
    sunElevation: 8,
  },
});

export const PRESET_ORDER = ['clear', 'humid', 'storm'];

export const DEFAULT_STATE = Object.freeze({
  quality: 'high',
  width: 960,
  height: 600,
  pixelRatio: 1,
  paused: false,
  simTime: 0,
  camAzimuth: 0,
  camElevation: 12,
  ...WEATHER_PRESETS.clear,
});

export function presetPatch(id) {
  const p = WEATHER_PRESETS[id];
  if (!p) return null;
  const { label, ...patch } = p;
  return patch;
}
