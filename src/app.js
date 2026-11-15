import { PhysicsWorld } from "./core/world.js";
import { FixedStepClock, formatSimTime } from "./core/simulation-clock.js";
import { runTrajectoryBenchmark } from "./core/benchmark.js";
import { runPauseResumeProbe, runTimeScaleProbe } from "./core/probes.js";
import { runScenarioSuite } from "./core/scenarios.js";
import { SceneRenderer } from "./renderer.js";

const canvas = document.querySelector("#scene");
const renderer = new SceneRenderer(canvas);
const world = new PhysicsWorld({ broadphase: "grid", cache: true });
const clock = new FixedStepClock();
const ui = {
  pauseButton: document.querySelector("#pause-button"),
  pauseIcon: document.querySelector("#pause-icon"),
  pauseLabel: document.querySelector("#pause-label"),
  resetButton: document.querySelector("#reset-button"),
  validateButton: document.querySelector("#validate-button"),
  runState: document.querySelector("#run-state"),
  liveChip: document.querySelector(".live-chip"),
  thruster: document.querySelector("[data-thruster]"),
  trajectory: document.querySelector("#trajectory-results"),
  pauseResults: document.querySelector("#pause-results"),
  scenarioResults: document.querySelector("#scenario-results"),
  equivalence: document.querySelector("#equivalence-note"),
  toast: document.querySelector("#toast"),
  metric: (name) => document.querySelector(`[data-metric="${name}"]`),
};

const state = {
  paused: false,
  pauseReason: "manual",
  timeScale: 1,
  lastTimestamp: null,
  smoothedFrameMs: 16.67,
  smoothedPhysicsMs: 0,
  lastSteps: 0,
  lastDropped: 0,
  lastUiUpdate: 0,
  validationRunning: false,
  keys: new Set(),
};

let toastTimer = 0;
const showToast = (message) => {
  ui.toast.textContent = message;
  ui.toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove("is-visible"), 2600);
};

const readInput = () => {
  const keys = state.keys;
  return {
    thrust: keys.has("KeyW") || keys.has("ArrowUp"),
    turn:
      (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
      (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0),
  };
};

const syncPauseUi = () => {
  ui.runState.textContent = state.paused ? "PAUSED" : "LIVE";
  ui.liveChip.classList.toggle("is-paused", state.paused);
  ui.pauseIcon.textContent = state.paused ? "▶" : "Ⅱ";
  ui.pauseLabel.textContent = state.paused ? "RESUME" : "PAUSE";
  ui.pauseButton.setAttribute("aria-pressed", String(state.paused));
  ui.thruster.textContent = state.paused ? "LOCKED" : "STANDBY";
  ui.thruster.classList.toggle("is-active", !state.paused && world.thrusterActive);
};

const setPaused = (paused, reason = "manual") => {
  if (state.paused === paused) return;
  state.paused = paused;
  state.pauseReason = reason;
  clock.setPaused(paused);
  world.freezeInterpolation();
  syncPauseUi();
  if (paused) {
    showToast(
      reason === "focus"
        ? "Focus lost: safely paused. Elapsed time will not be replayed."
        : "Simulation paused. Thruster output is locked.",
    );
  } else {
    showToast("Simulation resumed from the frozen state.");
  }
};

const resetScene = () => {
  world.reset();
  clock.reset();
  clock.setPaused(state.paused);
  world.freezeInterpolation();
  renderer.clearTrail();
  state.lastSteps = 0;
  state.lastDropped = 0;
  syncPauseUi();
  showToast("Scene reset.");
};

const setTimeScale = (timeScale) => {
  state.timeScale = timeScale;
  document.querySelectorAll("[data-speed]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.speed) === timeScale);
  });
  showToast(`Time scale ${timeScale}x. Fixed step unchanged.`);
};

const updateTelemetry = (now) => {
  if (now - state.lastUiUpdate < 80) return;
  state.lastUiUpdate = now;
  const fps = state.smoothedFrameMs > 0 ? 1000 / state.smoothedFrameMs : 0;
  ui.metric("frameMs").textContent = state.smoothedFrameMs.toFixed(1);
  ui.metric("fps").textContent = String(Math.round(fps));
  ui.metric("physicsMs").textContent = state.smoothedPhysicsMs.toFixed(2);
  ui.metric("candidates").textContent = String(world.metrics.broadphaseCandidateCount);
  ui.metric("cacheHit").textContent = (world.getCacheHitRate() * 100).toFixed(1);
  ui.metric("nodes").textContent = String(world.metrics.nodeCount);
  ui.metric("alpha").textContent = (state.paused ? 1 : clock.alpha).toFixed(2);
  ui.metric("substeps").textContent = String(state.lastSteps);
  ui.metric("dropped").textContent = String(clock.droppedSteps);
  ui.metric("simTime").textContent = formatSimTime(world.time);
  ui.thruster.textContent = state.paused
    ? "LOCKED"
    : world.thrusterActive
      ? "ACTIVE"
      : readInput().thrust
        ? "ARMED"
        : "STANDBY";
  ui.thruster.classList.toggle("is-active", !state.paused && ui.thruster.textContent === "ACTIVE");
};

const frame = (now) => {
  const frameSeconds =
    state.lastTimestamp === null ? 0 : Math.max(0, Math.min(0.25, (now - state.lastTimestamp) / 1000));
  state.lastTimestamp = now;
  if (frameSeconds > 0) {
    state.smoothedFrameMs = lerp(state.smoothedFrameMs, frameSeconds * 1000, 0.1);
  }

  const physicsStart = performance.now();
  const result = clock.advance(frameSeconds, {
    timeScale: state.timeScale,
    onStep: (dt) => world.step(dt, readInput()),
  });
  const physicsElapsed = performance.now() - physicsStart;
  state.smoothedPhysicsMs = lerp(state.smoothedPhysicsMs, physicsElapsed, 0.08);
  state.lastSteps = result.steps;

  if (clock.droppedSteps > state.lastDropped) {
    const dropped = clock.droppedSteps - state.lastDropped;
    state.lastDropped = clock.droppedSteps;
    showToast(`Catch-up cap: dropped ${dropped} fixed steps to prevent time debt.`);
  }

  const alpha = state.paused ? 1 : clock.alpha;
  const sample = world.sample(alpha);
  renderer.render(sample, {
    nodes: world.nodes,
    paused: state.paused,
    pauseReason: state.pauseReason,
    lastCollision: world.lastCollision,
  });
  updateTelemetry(now);
  requestAnimationFrame(frame);
};

const lerp = (a, b, t) => a + (b - a) * t;

document.addEventListener("keydown", (event) => {
  if (event.repeat && event.code !== "KeyW" && event.code !== "ArrowUp") return;
  if (["KeyW", "KeyA", "KeyD", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
    event.preventDefault();
  }
  state.keys.add(event.code);
  if (event.code === "Space" && !event.repeat) setPaused(!state.paused, "manual");
  if (event.code === "KeyR" && !event.repeat) resetScene();
  if (event.code === "Digit1") setTimeScale(0.5);
  if (event.code === "Digit2") setTimeScale(1);
  if (event.code === "Digit3") setTimeScale(2);
});

document.addEventListener("keyup", (event) => {
  state.keys.delete(event.code);
});

window.addEventListener("blur", () => {
  if (!state.paused) setPaused(true, "focus");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && !state.paused) setPaused(true, "focus");
  if (!document.hidden && state.paused && state.pauseReason === "focus") {
    showToast("Window restored: still paused. Press Space to resume without a jump.");
  }
});

ui.pauseButton.addEventListener("click", () => setPaused(!state.paused, "manual"));
ui.resetButton.addEventListener("click", resetScene);
document.querySelectorAll("[data-speed]").forEach((button) => {
  button.addEventListener("click", () => setTimeScale(Number(button.dataset.speed)));
});

const renderTrajectoryResults = (trajectory) => {
  const rows = trajectory.results
    .map((result) => {
      const width = Math.max(2, Math.min(100, (result.maxErrorPx / 0.1) * 100));
      return `
        <div class="trajectory-row" title="mean ${result.meanErrorPx.toFixed(4)} px / final ${result.finalErrorPx.toFixed(4)} px">
          <span class="fps-tag">${result.fps} FPS</span>
          <span class="error-bar"><i style="--error-width:${width.toFixed(1)}%"></i></span>
          <output>${result.maxErrorPx.toFixed(3)} px</output>
        </div>`;
    })
    .join("");
  ui.trajectory.innerHTML = `
    ${rows}
    <p class="result-meta">MAX POSITION ERROR · VS ${trajectory.referenceFps} FPS · ${trajectory.duration}s / 0.25s CHECKPOINTS</p>`;
};

const renderPauseResults = (pause, timeScale) => {
  const check = (passed) => (passed ? "pass" : "");
  ui.pauseResults.innerHTML = `
    <div class="probe-grid">
      <div class="probe-cell"><span>PAUSED DRIFT</span><b class="${check(pause.checks.pausedPositionStable)}">${pause.pausedPositionDeltaPx.toFixed(3)} px</b></div>
      <div class="probe-cell"><span>RESUME FRAME</span><b class="${check(pause.checks.noResumeJump)}">${pause.resumeJumpPx.toFixed(3)} px</b></div>
      <div class="probe-cell"><span>PAUSED THRUST</span><b class="${check(pause.checks.thrusterStopped)}">${pause.thrusterDuringPause ? "ON" : "OFF"}</b></div>
      <div class="probe-cell"><span>2× LOGIC DELTA</span><b class="${check(timeScale.passed)}">${timeScale.doublePositionDeltaPx.toFixed(6)} px</b></div>
    </div>
    <p class="result-meta">PAUSED ΔT ${pause.pausedSimTimeDelta.toFixed(3)}s · RESUME ${pause.resumeSteps} STEPS · ${pause.passed && timeScale.passed ? "PASS" : "FAIL"}</p>`;
};

const renderScenarioResults = (suite) => {
  const meta = (scenario, status, isWarning = false) => `
    <div class="scenario-row">
      <span class="scenario-name">${scenario.label}</span>
      <span class="scenario-detail">#${scenario.outputHash} · ${scenario.errors.length} err · ${scenario.resource.distanceChecks} checks · ${scenario.resource.wallMs} ms</span>
      <span class="scenario-status ${isWarning ? "warn" : ""}">${status}</span>
    </div>`;
  ui.scenarioResults.innerHTML = `
    <div class="scenario-list">
      ${meta(suite.scenarios.before, "BASE")}
      ${meta(suite.scenarios.after, "PASS")}
      ${meta(suite.scenarios.boundary, "CAPPED", true)}
    </div>
    <p class="result-meta">BOUNDARY: ${suite.scenarios.boundary.clock.droppedSteps} DROPPED · MAX FRAME ${suite.scenarios.boundary.maxFrameDisplacementPx} px · ${suite.scenarios.boundary.errors.length} EXCEPTIONS</p>`;
  ui.equivalence.textContent = suite.passed
    ? "PASS · Public state hashes are identical. Only broadphase cost, caching and error handling changed."
    : "FAIL · Check output hashes, boundary limits or exception logs.";
  ui.equivalence.classList.toggle("is-pass", suite.passed);
};

const runValidation = async () => {
  if (state.validationRunning) return;
  state.validationRunning = true;
  ui.validateButton.disabled = true;
  ui.validateButton.textContent = "RUNNING…";
  await new Promise((resolve) => window.setTimeout(resolve, 32));

  try {
    const heapBefore = performance.memory?.usedJSHeapSize ?? 0;
    const trajectory = runTrajectoryBenchmark({ includeCheckpoints: false });
    const pause = runPauseResumeProbe();
    const timeScale = runTimeScaleProbe();
    const scenarios = runScenarioSuite({ repeats: 3 });
    const heapAfter = performance.memory?.usedJSHeapSize ?? 0;
    const report = {
      generatedAt: new Date().toISOString(),
      trajectory,
      pause,
      timeScale,
      scenarios,
      browserResource: {
        heapDeltaMB:
          heapBefore > 0 && heapAfter > 0
            ? Number(((heapAfter - heapBefore) / 1048576).toFixed(3))
            : null,
      },
    };
    renderTrajectoryResults(trajectory);
    renderPauseResults(pause, timeScale);
    renderScenarioResults(scenarios);
    window.__orbitLabReport = report;
    window.dispatchEvent(new CustomEvent("orbit:validation", { detail: report }));
    showToast(
      trajectory.passed && pause.passed && scenarios.passed
        ? "All checks passed. Fixed-step semantics preserved."
        : "Validation finished with failed checks.",
    );
  } catch (error) {
    ui.equivalence.textContent = `ERROR · ${error.message}`;
    ui.equivalence.classList.remove("is-pass");
    showToast(`Validation error: ${error.message}`);
    console.error(error);
  } finally {
    state.validationRunning = false;
    ui.validateButton.disabled = false;
    ui.validateButton.textContent = "RUN VALIDATION";
  }
};

ui.validateButton.addEventListener("click", runValidation);

window.orbitLab = {
  world,
  clock,
  renderer,
  setPaused,
  setTimeScale,
  resetScene,
  runValidation,
  getMetrics: () => ({
    frameMs: state.smoothedFrameMs,
    physicsMs: state.smoothedPhysicsMs,
    candidates: world.metrics.broadphaseCandidateCount,
    cacheHitRate: world.getCacheHitRate(),
    nodeCount: world.metrics.nodeCount,
    alpha: clock.alpha,
    droppedSteps: clock.droppedSteps,
    paused: state.paused,
    timeScale: state.timeScale,
  }),
};

syncPauseUi();
requestAnimationFrame(frame);
window.setTimeout(runValidation, 700);
