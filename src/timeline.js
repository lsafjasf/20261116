import {
  TICK_SECONDS,
  SAVE_VERSION,
  createInitialState,
  stepSimulation
} from "./simulation.js";

const round = (value, digits = 2) => Number(value.toFixed(digits));

export function frameFromState(state, order = "left-first") {
  return {
    t: round(state.time, 3),
    tick: state.tick,
    stage: state.stage,
    progress: state.progress,
    x: state.x,
    altitude: state.altitude,
    verticalSpeed: state.verticalSpeed,
    speed: state.speed,
    pitch: state.pitch,
    roll: state.roll,
    order,
    left: {
      throttle: round(state.controls.left.throttle, 1),
      fuelPump: round(state.controls.left.fuelPump, 1),
      rpm: state.engine.rpm,
      thrust: state.engine.thrust,
      fuel: state.engine.fuel,
      temperature: round(state.engine.temperature, 1),
      stress: state.engine.stress,
      damage: state.engine.damage
    },
    right: {
      hydraulic: round(state.controls.right.hydraulic, 1),
      gearLever: state.controls.right.gearLever,
      pump: state.hydraulic.pump,
      pressure: round(state.hydraulic.pressure, 1),
      temperature: round(state.hydraulic.temperature, 1),
      stress: state.hydraulic.stress,
      damage: state.hydraulic.damage,
      gearPosition: state.hydraulic.gearPosition,
      gearTransit: state.hydraulic.gearTransit
    },
    shared: {
      hull: state.shared.hull,
      crossDrag: state.shared.crossDrag,
      collisionCount: state.shared.collisionCount,
      alerts: state.shared.alerts.map((alert) => ({ ...alert }))
    },
    mission: { ...state.mission },
    collision: state.lastCollision ? { ...state.lastCollision } : null
  };
}

export function createTimeline(state = createInitialState(), meta = {}) {
  return {
    version: SAVE_VERSION,
    createdAt: new Date().toISOString(),
    mode: state.mode,
    label: meta.label || "实时任务",
    initial: frameFromState(state),
    frames: [frameFromState(state)],
    inputs: [],
    collisions: [],
    conflicts: [],
    events: []
  };
}

export function recordInput(timeline, state, { source, action, value, sequence }) {
  const event = {
    type: "input",
    t: round(state.time, 3),
    tick: state.tick,
    source,
    action,
    value,
    sequence
  };
  timeline.inputs.push(event);
  timeline.events.push(event);
  return event;
}

export function recordFrame(timeline, state, { order, collision, event } = {}) {
  const frame = frameFromState(state, order);
  timeline.frames.push(frame);
  if (collision) {
    const collisionEvent = {
      type: "collision",
      t: collision.time,
      tick: collision.tick,
      x: collision.x,
      y: collision.y,
      object: collision.object,
      reason: collision.reason,
      damage: collision.damage,
      severity: collision.severity
    };
    timeline.collisions.push(collisionEvent);
    timeline.events.push(collisionEvent);
  }
  if (event) timeline.events.push({ ...event, t: round(state.time, 3), tick: state.tick });
  return frame;
}

function orderSignature(result) {
  const state = result.state;
  return {
    rpm: state.engine.rpm,
    pressure: state.hydraulic.pressure,
    altitude: state.altitude,
    speed: state.speed,
    stage: state.stage,
    failureReason: state.mission.failureReason,
    gearPosition: state.hydraulic.gearPosition,
    hull: state.shared.hull
  };
}

export function inspectOrderConflict(state, sides = ["left", "right"], dt = TICK_SECONDS) {
  if (!sides.includes("left") || !sides.includes("right")) return null;
  if (state.stage === "FAILED" || state.stage === "SUCCESS") return null;

  const leftFirst = stepSimulation(state, dt, { order: "left-first" });
  const rightFirst = stepSimulation(state, dt, { order: "right-first" });
  const a = orderSignature(leftFirst);
  const b = orderSignature(rightFirst);
  const delta = {
    rpm: round(Math.abs(a.rpm - b.rpm), 3),
    pressure: round(Math.abs(a.pressure - b.pressure), 3),
    altitude: round(Math.abs(a.altitude - b.altitude), 3),
    speed: round(Math.abs(a.speed - b.speed), 3),
    gearPosition: round(Math.abs(a.gearPosition - b.gearPosition), 4)
  };
  const orderSensitive =
    delta.rpm > 0.001 ||
    delta.pressure > 0.001 ||
    delta.altitude > 0.001 ||
    delta.speed > 0.001 ||
    delta.gearPosition > 0.001 ||
    a.stage !== b.stage ||
    a.failureReason !== b.failureReason;
  if (!orderSensitive) return null;

  return {
    type: "conflict",
    t: round(state.time + dt, 3),
    tick: state.tick + 1,
    actualOrder: "left-first",
    alternateOrder: "right-first",
    sides: [...sides],
    delta,
    position: { x: round(state.x, 2), altitude: round(state.altitude, 2) },
    objects: [
      {
        id: "engine",
        label: "左发动机",
        x: round(state.x + 4.1, 2),
        y: round(state.altitude + 2.7, 2)
      },
      {
        id: "hydraulic-gear",
        label: "液压/起落架",
        x: round(state.x - 1.8, 2),
        y: round(state.altitude + 0.85, 2)
      }
    ],
    summary: "同帧左右动作的更新顺序改变了交叉耦合结果"
  };
}

export function recordConflict(timeline, conflict, order) {
  if (!conflict) return;
  const existing = timeline.conflicts.find((item) => item.tick === conflict.tick);
  if (existing) return;
  const actualOrder = order === "right-first" ? "right-first" : "left-first";
  const alternateOrder = actualOrder === "left-first" ? "right-first" : "left-first";
  timeline.conflicts.push({ ...conflict, actualOrder, alternateOrder });
  timeline.events.push({
    type: "conflict",
    t: conflict.t,
    tick: conflict.tick,
    actualOrder,
    alternateOrder,
    position: conflict.position,
    objects: conflict.objects,
    summary: conflict.summary
  });
}

export function finalFrame(timeline) {
  return timeline.frames[timeline.frames.length - 1];
}

export function serializeTimeline(timeline) {
  return JSON.stringify(timeline);
}

export function parseTimeline(raw) {
  if (!raw) return null;
  try {
    const timeline = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!timeline || timeline.version !== SAVE_VERSION || !Array.isArray(timeline.frames)) return null;
    if (timeline.frames.length === 0) return null;
    return timeline;
  } catch {
    return null;
  }
}

export class ReplayController {
  constructor(frames, options = {}) {
    if (!Array.isArray(frames) || frames.length === 0) throw new Error("Replay requires frames");
    this.frames = frames;
    this.cursor = options.cursor ?? 0;
    this.speed = options.speed ?? 1;
    this.playing = false;
    this.accumulator = 0;
    this.finalHash = this.hashFinal();
  }

  get frame() {
    return this.frames[Math.min(this.cursor, this.frames.length - 1)];
  }

  get progress() {
    return this.frames.length <= 1 ? 1 : this.cursor / (this.frames.length - 1);
  }

  play() {
    if (this.cursor >= this.frames.length - 1) this.cursor = 0;
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  step(direction = 1) {
    this.playing = false;
    this.cursor = Math.max(0, Math.min(this.frames.length - 1, this.cursor + direction));
    return this.frame;
  }

  seek(fraction) {
    this.playing = false;
    this.cursor = Math.round(Math.max(0, Math.min(1, fraction)) * (this.frames.length - 1));
    return this.frame;
  }

  setSpeed(speed) {
    this.speed = [0.5, 1, 2, 4].includes(speed) ? speed : 1;
    return this.speed;
  }

  advance(deltaSeconds) {
    if (!this.playing) return this.frame;
    this.accumulator += Math.max(0, deltaSeconds) * this.speed;
    const frameStep = 1 / 20;
    while (this.accumulator >= frameStep && this.cursor < this.frames.length - 1) {
      this.cursor += 1;
      this.accumulator -= frameStep;
    }
    if (this.cursor >= this.frames.length - 1) {
      this.cursor = this.frames.length - 1;
      this.playing = false;
      this.accumulator = 0;
    }
    return this.frame;
  }

  final() {
    return this.frames[this.frames.length - 1];
  }

  hashFinal() {
    const value = JSON.stringify(this.frames[this.frames.length - 1]);
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  verifyFinalUnchanged() {
    return this.hashFinal() === this.finalHash;
  }
}
