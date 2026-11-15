// Global simulation configuration.
// All values are SI-ish units: meters, cubic meters, seconds, percent.

export const TICK_SECONDS = 0.25;
export const SIM_SECONDS = 30 * 60; // 30 minute mission
export const TOTAL_TICKS = Math.round(SIM_SECONDS / TICK_SECONDS); // 7200

// Geometry
export const UPSTREAM_AREA = 5000; // m^2 surface area of upstream pool
export const CHANNEL_AREA = 9000; // m^2 surface area of controlled channel
export const GATE_WIDTH = 6; // m
export const GATE_DISCHARGE_CD = 0.62;
export const GRAVITY = 9.81;

// Levels (m)
export const INITIAL_UPSTREAM_LEVEL = 3.4;
export const INITIAL_CHANNEL_LEVEL = 2.6;
export const CHANNEL_BANK_LEVEL = 4.2; // water above this spills into the street
export const STREET_FAILURE_LEVEL = 0.25; // street flood depth that fails the mission
export const STREET_VOLUME = 1100; // m^3 per meter of effective street storage
export const STREET_DRAIN_PER_SEC = 0.00012; // natural drainage (depth meters / s)
export const SAFE_CHANNEL_MAX = 4.05; // operator safety band
export const SAFE_CHANNEL_MIN = 1.8;

// Pump
export const PUMP_RATED_FLOW = 7.2; // m^3/s at full speed
export const PUMP_RAMP_PER_TICK = 0.08; // speed change per tick (0..1)
export const HEAT_PER_FLOW = 5.2; // degC added per tick at full flow
export const HEAT_COOLING = 0.5; // degC removed per tick at zero flow
export const OVERHEAT_TEMP = 100; // degC: pump trips and durability is lost
export const START_DURABILITY = 100;
export const OVERHEAT_DURABILITY_LOSS = 40;
export const MIN_DURABILITY = 10; // below this the mission fails
export const MAX_TRIPS = 2; // repeated overheat trips destroy the station

// Pressure (kPa) across the gate/channel structure
export const PRESSURE_WARN = 7;
export const PRESSURE_CRITICAL = 11;
export const COLLISION_DP = 10.5; // pressure differential treated as a structural collision

// Networking: commands from each side arrive at the shared state with delay
export const GATE_LATENCY_TICKS = 4; // ~1 s
export const PUMP_LATENCY_TICKS = 4;
export const LATENCY_JITTER = 2; // +0..2 ticks, drawn from the seeded RNG

// Inflow hydrograph: two storm peaks over 30 minutes
export const INFLOW_EVENTS = [
  { t: 0, q: 4.0 },
  { t: 180, q: 13.5 },
  { t: 420, q: 26.0 },
  { t: 720, q: 12.0 },
  { t: 1020, q: 20.5 },
  { t: 1260, q: 8.0 },
  { t: 1560, q: 5.5 },
  { t: 1800, q: 4.2 }
];
export const INFLOW_JITTER = 0.55; // m^3/s deterministic noise amplitude

// RNG seed (mulberry32)
export const DEFAULT_SEED = 20261116;

// Save / recording
export const CHECKPOINT_EVERY = 240; // full snapshot every 60 s of sim time
export const SAVE_KEY = 'river-cop-save-v1';

export function inflowAt(seconds, rand) {
  const ev = INFLOW_EVENTS;
  let q = ev[ev.length - 1].q;
  for (let i = 0; i < ev.length - 1; i++) {
    const a = ev[i];
    const b = ev[i + 1];
    if (seconds >= a.t && seconds <= b.t) {
      const f = (seconds - a.t) / (b.t - a.t);
      const s = f * f * (3 - 2 * f); // smoothstep
      q = a.q + (b.q - a.q) * s;
      break;
    }
  }
  return Math.max(0, q + (rand() * 2 - 1) * INFLOW_JITTER);
}
