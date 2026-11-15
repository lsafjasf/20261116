// Static configuration: lanes, difficulty windows and synthesis defaults.

export const LANES = [
  { id: 0, key: 'd', angle: 0,               label: 'D', pan: -0.7, drum: 'kick'  },
  { id: 1, key: 'f', angle: Math.PI / 2,     label: 'F', pan:  0.0, drum: 'snare' },
  { id: 2, key: 'j', angle: Math.PI,         label: 'J', pan:  0.0, drum: 'hihat' },
  { id: 3, key: 'k', angle: Math.PI * 1.5,   label: 'K', pan:  0.7, drum: 'clap'  },
];

// Judgment windows in seconds; tiers are Perfect / Good / Miss.
export const DIFFICULTIES = {
  easy:   { name: 'easy',   windows: { perfect: 0.090, good: 0.160 }, missWindow: 0.160 },
  normal: { name: 'normal', windows: { perfect: 0.060, good: 0.110 }, missWindow: 0.110 },
  hard:   { name: 'hard',   windows: { perfect: 0.035, good: 0.075 }, missWindow: 0.075 },
};

export const DEFAULT_PARAMS = {
  bpm: 120,
  beats: 48,
  difficulty: 'normal',
  approachTime: 1.4,       // seconds a note spends travelling to the judgment line
  offsetMs: 0,             // user calibration: positive = hit later
  masterGain: 0.8,
  drumGain: 0.9,
  hitGain: 0.7,
  swing: 0,
};

export const STORAGE_KEY = 'rhythm-game-snapshot-v1';
export const SNAPSHOT_VERSION = 1;

export const JUDGE_TIERS = ['perfect', 'good', 'miss'];
