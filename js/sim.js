// Deterministic coupled-oscillator network (8 nodes).
// Kuramoto-style phase coupling + damped amplitude dynamics.
// Same (params, seed, ticks) always reproduces the same state,
// which is what makes snapshot save/restore bit-exact.

export const N = 8;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultParams() {
  return {
    coupling: 0.6,      // global coupling strength K (0..2)
    phaseOffset: 0.0,   // phase lag phi injected into coupling (rad, 0..PI)
    damping: 0.35,      // amplitude damping (0..1)
    baseFreq: 110,      // lowest voice frequency (Hz)
    spread: 1.5,        // frequency spread ratio across voices
    seed: 20261116,
  };
}

export function createSim(params, seed) {
  const p = { ...defaultParams(), ...params };
  const rng = mulberry32(seed ?? p.seed);
  const phases = new Float64Array(N);
  const amps = new Float64Array(N);
  const freqs = new Float64Array(N);
  const pans = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    phases[i] = rng() * Math.PI * 2;
    amps[i] = 0.55 + rng() * 0.2;
    freqs[i] = p.baseFreq * Math.pow(p.spread, i / (N - 1));
    pans[i] = (i / (N - 1)) * 1.6 - 0.8; // fixed stereo layout
  }
  // Fixed symmetric coupling topology (ring + chords), scaled by K at runtime.
  const topo = [];
  for (let i = 0; i < N; i++) {
    topo.push(new Float64Array(N));
    topo[i][(i + 1) % N] = 1;
    topo[i][(i + N - 1) % N] = 0.6;
    if (i % 2 === 0) topo[i][(i + 3) % N] = 0.4;
  }
  return { params: p, phases, amps, freqs, pans, topo, tick: 0 };
}

const AMP_MIN = 0.08;  // silence guard: voices never fully die
const AMP_MAX = 1.0;   // blowup guard: hard ceiling per voice
const DT = 1 / 60;     // fixed sim step

export function stepSim(sim) {
  const { params: p, phases, amps, topo } = sim;
  const K = p.coupling, phi = p.phaseOffset, damp = p.damping;
  const dPhase = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let drive = 0;
    for (let j = 0; j < N; j++) {
      const w = topo[i][j];
      if (w !== 0) drive += w * Math.sin(phases[j] - phases[i] + phi);
    }
    dPhase[i] = K * drive;
  }
  for (let i = 0; i < N; i++) {
    phases[i] += dPhase[i] * DT;
    // Amplitude relaxes toward a synchrony-linked target; damping keeps
    // total energy bounded so the network can neither die nor blow up.
    const sync = 0.5 + 0.5 * Math.cos(dPhase[i]);
    const target = AMP_MIN + (AMP_MAX - AMP_MIN) * (0.35 + 0.65 * sync * (1 - damp * 0.7));
    amps[i] += (target - amps[i]) * (0.05 + damp * 0.2);
    if (amps[i] < AMP_MIN) amps[i] = AMP_MIN;
    else if (amps[i] > AMP_MAX) amps[i] = AMP_MAX;
    if (phases[i] > 1e6) phases[i] %= (Math.PI * 2);
  }
  sim.tick++;
  return sim;
}

// Kuramoto order parameter r in [0,1]: 1 = locked (stable beat), low = complex.
export function orderParameter(sim) {
  let re = 0, im = 0;
  for (let i = 0; i < N; i++) { re += Math.cos(sim.phases[i]); im += Math.sin(sim.phases[i]); }
  return Math.hypot(re, im) / N;
}

// Instantaneous per-voice output used by both realtime and offline audio.
export function voiceState(sim, i) {
  const vibr = 1 + 0.004 * Math.sin(sim.phases[i]); // subtle phase-linked vibrato
  return {
    freq: sim.freqs[i] * vibr,
    gain: sim.amps[i] / Math.sqrt(N), // energy-normalized: no blowup as N grows
    pan: sim.pans[i],
  };
}

// Beat peaks: local maxima of the summed amplitude envelope, computed on a
// throwaway copy so the live sim is not disturbed.
export function beatTimes(sim, ticks) {
  const copy = restoreSim(snapshotOf(sim));
  const env = [];
  for (let t = 0; t < ticks; t++) {
    stepSim(copy);
    let s = 0;
    for (let i = 0; i < N; i++) s += copy.amps[i] * Math.cos(copy.phases[i]);
    env.push(s);
  }
  const beats = [];
  for (let t = 1; t < ticks - 1; t++) {
    if (env[t] > env[t - 1] && env[t] >= env[t + 1] && env[t] > 0.3) beats.push(copy.tick - ticks + t);
  }
  return beats;
}

export function snapshotOf(sim) {
  return {
    params: { ...sim.params },
    phases: [...sim.phases],
    amps: [...sim.amps],
    tick: sim.tick,
  };
}

export function restoreSim(snap) {
  const sim = createSim(snap.params, snap.params.seed);
  sim.phases.set(snap.phases);
  sim.amps.set(snap.amps);
  sim.tick = snap.tick;
  return sim;
}
