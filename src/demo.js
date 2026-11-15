import {
  STAGE_LABELS,
  createInitialState,
  stepSimulation,
  TICK_SECONDS
} from "./simulation.js";
import {
  createTimeline,
  inspectOrderConflict,
  recordConflict,
  recordFrame,
  recordInput
} from "./timeline.js";

function setControl(state, timeline, source, action, value, sequence) {
  if (source === "left") state.controls.left[action] = value;
  else state.controls.right[action] = value;
  recordInput(timeline, state, {
    source,
    action,
    value,
    sequence
  });
}

function runDemo(kind) {
  let state = createInitialState();
  state.mode = "demo";
  const timeline = createTimeline(state, {
    label: kind === "success" ? "完整成功样例：起飞—绕飞—降落" : "失败样例：地面误收起落架"
  });
  let sequence = 0;
  let gearUpSent = false;
  let approachSent = false;
  let orderBurstSent = false;
  const maxTicks = kind === "success" ? 1800 : 420;

  for (let index = 0; index < maxTicks; index += 1) {
    const changedSides = new Set();

    if (state.tick === 0) {
      setControl(state, timeline, "left", "throttle", 78, ++sequence);
      setControl(state, timeline, "left", "fuelPump", 68, ++sequence);
      setControl(state, timeline, "right", "hydraulic", 68, ++sequence);
    }

    if (kind === "success" && state.time >= 2.05 && !orderBurstSent) {
      setControl(state, timeline, "left", "throttle", 72, ++sequence);
      setControl(state, timeline, "right", "hydraulic", 56, ++sequence);
      changedSides.add("left");
      changedSides.add("right");
      orderBurstSent = true;
    }

    if (kind === "success" && state.time >= 3 && orderBurstSent && state.controls.left.throttle === 72) {
      setControl(state, timeline, "left", "throttle", 78, ++sequence);
      setControl(state, timeline, "right", "hydraulic", 68, ++sequence);
      changedSides.add("left");
      changedSides.add("right");
    }

    if (kind === "success" && state.stage === "AIRBORNE" && state.altitude > 58 && !gearUpSent) {
      setControl(state, timeline, "right", "gearLever", "UP", ++sequence);
      changedSides.add("right");
      gearUpSent = true;
    }

    if (kind === "success" && state.stage === "APPROACH" && !approachSent) {
      setControl(state, timeline, "left", "throttle", 38, ++sequence);
      setControl(state, timeline, "left", "fuelPump", 62, ++sequence);
      setControl(state, timeline, "right", "hydraulic", 66, ++sequence);
      setControl(state, timeline, "right", "gearLever", "DOWN", ++sequence);
      changedSides.add("left");
      changedSides.add("right");
      approachSent = true;
    }

    if (kind === "failure" && state.time >= 8.5 && !gearUpSent) {
      setControl(state, timeline, "right", "gearLever", "UP", ++sequence);
      changedSides.add("right");
      gearUpSent = true;
    }

    if (changedSides.size === 2 && timeline.conflicts.length < 5) {
      recordConflict(timeline, inspectOrderConflict(state, [...changedSides]), "left-first");
    }

    const previousStage = state.stage;
    const result = stepSimulation(state, TICK_SECONDS, { order: "left-first" });
    state = result.state;
    if (state.stage !== previousStage) {
      timeline.events.push({
        type: "stage",
        t: state.time,
        tick: state.tick,
        stage: state.stage,
        stageLabel: STAGE_LABELS[state.stage] || state.stage
      });
    }
    recordFrame(timeline, state, { order: "left-first", collision: result.collision });

    if (state.stage === "SUCCESS" || state.stage === "FAILED") break;
  }

  return {
    timeline,
    finalState: state,
    success: state.stage === "SUCCESS"
  };
}

export function createSuccessDemo() {
  return runDemo("success");
}

export function createFailureDemo() {
  return runDemo("failure");
}

export function createDemoRuns() {
  return {
    success: createSuccessDemo(),
    failure: createFailureDemo()
  };
}
