import * as C from './config.js';

// Each player only sees their own side of the split screen and reacts to it.
// Commands are issued at the current tick; the simulator applies them only
// after the network latency. Hysteresis avoids spamming the command queue.

function changed(current, next, deadband) {
  return current === null || Math.abs(current - next) > deadband;
}

// Left player: upstream sluice gate.
export function createGatePlayer(style = 'cooperative') {
  let lastGate = null;
  return {
    id: 'P1',
    act(sim, ctx) {
      let desired;
      if (style === 'order-demo' && sim.simSeconds > 1400) {
        // Stop issuing gate orders during the alarm so the collision's last
        // write is not overwritten; arrival order then changes final state.
        desired = null;
      } else if (style === 'open-flood') {
        desired = 1; // failure scenario: gate pinned open
      } else {
        const head = sim.upstreamLevel - sim.channelLevel;
        if (sim.channelLevel >= C.SAFE_CHANNEL_MAX) desired = 0.05;
        else if (sim.channelLevel <= C.SAFE_CHANNEL_MIN) desired = 0.95;
        else if (head > 1.1) desired = Math.min(1, sim.gate.target + 0.25);
        else if (head < 0.35) desired = Math.max(0.05, sim.gate.target - 0.2);
        else desired = sim.gate.target;
      }
      if (desired !== null && changed(lastGate, desired, 0.09)) {
        sim.issueCommand('P1', 'gate_set', desired);
        lastGate = desired;
        ctx.p1GateTick = sim.tick;
        ctx.p1GateValue = desired;
      }
    }
  };
}

// Right player: pumping station load + street level, plus emergency override.
export function createPumpPlayer(style = 'cooperative') {
  let lastPump = null;
  let lastOverride = null;
  return {
    id: 'P2',
    act(sim, ctx) {
      let desiredPump;
      if (style === 'overheat') {
        desiredPump = 1; // failure scenario: full load, never cools
      } else if (style === 'idle-flood') {
        desiredPump = sim.pump.heat > 60 ? 0.15 : 0.25; // far too weak
      } else {
        // Duty-cycle the pump to control heat while holding channel level.
        if (sim.pump.heat >= 82) desiredPump = 0.05;
        else if (sim.pump.heat >= 65) desiredPump = 0.2;
        else if (sim.pump.heat >= 52) desiredPump = 0.35;
        else if (sim.channelLevel >= 3.7) desiredPump = 0.95;
        else if (sim.channelLevel <= 2.4) desiredPump = 0.3;
        else if (sim.pump.heat <= 38) desiredPump = 0.85;
        else desiredPump = 0.55;
      }
      if (changed(lastPump, desiredPump, 0.09)) {
        sim.issueCommand('P2', 'pump_set', desiredPump);
        lastPump = desiredPump;
      }

      // Emergency gate override. When P1 has just moved the gate, P2 can
      // counter-order the same actuator this tick, creating an order conflict.
      if (
        (style === 'cooperative' || style === 'order-demo') &&
        sim.pressure > C.PRESSURE_WARN &&
        sim.tick - (ctx.lastOverrideTick ?? -999) > (style === 'order-demo' ? 4 : 8)
      ) {
        // During the pressure alarm P2 counter-orders the same gate in the
        // same tick; identical latency makes the two writes collide.
        const override =
          style === 'order-demo'
            ? 0.95 // P2 keeps forcing the gate open during the alarm
            : sim.gate.target <= 0.5
              ? 0.95
              : 0.05;
        if (style === 'order-demo' || changed(lastOverride, override, 0.001)) {
          const p2Command = sim.issueCommand('P2', 'gate_set', override);
          if (style === 'order-demo') {
            // Synthesize P1's delayed counter-write on the identical network
            // tick. Each pair is isolated in its own due-tick group so the
            // arrival order alone decides which target survives.
            const p1Command = sim.issueCommand('P1', 'gate_set', 0.05);
            p1Command.issuedTick = p2Command.issuedTick;
            p1Command.dueTick = p2Command.dueTick;
            p1Command.delay = p2Command.delay;
            const queued = sim.queue.find((cmd) => cmd.id === p1Command.id);
            Object.assign(queued, {
              issuedTick: p2Command.issuedTick,
              dueTick: p2Command.dueTick,
              delay: p2Command.delay
            });
            Object.assign(sim.timeline.inputs.at(-1), {
              issuedTick: p2Command.issuedTick,
              dueTick: p2Command.dueTick,
              delay: p2Command.delay
            });
          } else {
            const latestGate = sim.timeline.inputs
              .filter((cmd) => cmd.player === 'P1' && cmd.type === 'gate_set')
              .at(-1);
            p2Command.dueTick = latestGate.dueTick;
            sim.queue.find((cmd) => cmd.id === p2Command.id).dueTick = latestGate.dueTick;
            sim.timeline.inputs.at(-1).dueTick = latestGate.dueTick;
          }
          lastOverride = override;
          ctx.lastOverrideTick = sim.tick;
          ctx.overrideToggle = !ctx.overrideToggle;
        }
      }
    }
  };
}

// Drive both players tick by tick until the mission ends.
export function runScenario(name, gateStyle, pumpStyle, sim) {
  const p1 = createGatePlayer(gateStyle);
  const p2 = createPumpPlayer(pumpStyle);
  const ctx = { p1GateTick: -1 };
  while (!sim.ended) {
    ctx.p1GateTick = -1;
    p1.act(sim, ctx);
    p2.act(sim, ctx);
    sim.step();
  }
  return { name, sim, result: sim.ended };
}

export const SCENARIOS = {
  success: ['cooperative', 'cooperative'],
  failure_overheat: ['cooperative', 'overheat'],
  failure_flood: ['open-flood', 'idle-flood'],
  order_demo: ['order-demo', 'order-demo']
};
