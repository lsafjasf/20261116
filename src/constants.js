// All tunable simulation constants live here.
export const TICK_MS = 100;          // fixed integration step
export const MAX_DEPTH = 150;        // hull crush depth (m)
export const SAFE_DEPTH = 120;       // beyond this depth hull wears
export const SURFACE_DEPTH = 0.5;    // close enough to the surface
export const SAMPLE_RADIUS = 4.5;    // horizontal-less model: depth window (m)
export const SAMPLE_COUNT_GOAL = 3;
export const SAMPLE_MIN_DEPTH = 25;
export const SAMPLE_MAX_DEPTH = 105;

export const BALLAST_MIN = 0;        // 0 = full air (buoyant), 1 = full flood
export const BALLAST_MAX = 1;
export const BALLAST_RATE = 0.045;   // valve change per tick
export const BALLAST_NEUTRAL = 0.5;
// vertical velocity: negative = ascending
export const ACCEL_K = 0.9;          // buoyancy acceleration coefficient
export const DRAG = 0.82;            // vertical drag per tick
export const BLOW_RATE = 0.22;       // emergency blow: ballast dumped per tick
export const CURRENT_PUSH = 0.35;    // random current velocity impulse
export const RUNAWAY_SPEED = 2.2;    // |vs| above this = loss of control
export const RUNAWAY_DEPTH = 12;     // runaway only counts below this depth
export const RECOVER_SPEED = 0.8;    // slow below this to regain control
export const SURFACE_SAFE_SPEED = 1.2;

export const POWER_BASE = 4;         // always-on systems (kW)
export const POWER_LIGHT = [0, 6, 14]; // off / standard / floodlight
export const THRUST_MAX = 1.0;
export const BATTERY_MAX = 100;
export const DISCHARGE_K = 0.012;    // energy per kW per tick
export const CHARGE_RATE = 0.35;     // surface recharge per tick
export const LOW_BATTERY = 15;

export const O2_MAX = 100;
export const O2_DRAIN = 0.045;       // per tick
export const O2_REFILL = 0.6;        // per tick while valve open at surface
export const LOW_O2 = 18;

export const TEMP_MIN = 5;
export const TEMP_MAX = 35;
export const TEMP_SETTLE = 0.01;     // drift toward ambient
export const TEMP_GRAD_K = 0.22;     // rapid vertical movement effect
export const TEMP_SAFE_LOW = 8;
export const TEMP_SAFE_HIGH = 32;

export const HULL_MAX = 100;
export const HULL_DEPTH_K = 0.05;    // wear per tick beyond safe depth
export const HULL_SPEED_K = 0.06;    // wear per tick during runaway
export const HULL_TEMP_K = 0.03;     // wear per tick at extreme temp

export const CHECKPOINT_EVERY = 20;  // ticks between recovery snapshots
export const CHECKPOINT_KEEP = 4;    // ring buffer size

export const PHASE = Object.freeze({
  READY: 'READY', DIVING: 'DIVING', SAMPLING: 'SAMPLING',
  ASCENDING: 'ASCENDING', RUNAWAY: 'RUNAWAY', SURFACED: 'SURFACED',
  FAILED: 'FAILED', PAUSED: 'PAUSED', RECOVERED: 'RECOVERED',
});

export const FAIL_REASON = Object.freeze({
  HULL: 'HULL_BREACH', O2: 'OXYGEN_DEPLETED',
  BATTERY: 'BATTERY_DEAD', CRUSH: 'CRUSH_DEPTH',
});

// 8-bit input record shared by both stations.
export const INPUT = Object.freeze({
  THRUST: 0,        // -1 reverse, 0 idle, 1 forward
  LIGHT: 1,         // 0/1/2
  FLOOD: 2,         // fill ballast (station B)
  VENT: 3,          // empty ballast (station B)
  NEUTRAL: 4,       // snap ballast to neutral (station B)
  BLOW: 5,          // emergency blow valve (station B)
  ENGINE: 6,        // master engine on/off (station A)
  SAMPLE: 7,        // trigger sampler (station A)
});
