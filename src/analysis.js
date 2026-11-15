import { Simulation, hashObject } from './simulation.js';

// Re-run a recorded timeline with an explicit tie-break winner. Swapping the
// winner models the two possible arrival orders over a delayed network.
function runWithOrderPolicy(recording, winner) {
  const sim = new Simulation(recording.seed);
  const inputs = [...recording.timeline.inputs].sort(
    (a, b) => a.issuedTick - b.issuedTick || a.id.localeCompare(b.id)
  );
  let index = 0;
  // Override the simulator's default tie-break so we can model the two
  // possible packet arrival orders over the delayed network directly.
  sim.applyDueCommands = function applyOrderedCommands() {
    const due = this.queue.filter((cmd) => cmd.dueTick <= this.tick);
    if (due.length === 0) return;
    this.detectConflicts(due);
    due.sort((a, b) => {
      if (a.dueTick === b.dueTick && a.type === b.type) {
        if (a.player === b.player) return a.id.localeCompare(b.id);
        // Last write wins; the chosen winner is applied last.
        if (a.player === winner && b.player !== winner) return 1;
        if (b.player === winner && a.player !== winner) return -1;
        return a.id.localeCompare(b.id);
      }
      return (
        a.dueTick - b.dueTick ||
        a.type.localeCompare(b.type) ||
        a.id.localeCompare(b.id)
      );
    });
    for (const cmd of due) {
      if (cmd.type === 'pump_set') this.pump.target = cmd.value;
      else this.gate.target = cmd.value;
      this.recordEvent('command_applied', {
        commandId: cmd.id,
        player: cmd.player,
        type: cmd.type,
        value: cmd.value
      });
    }
    this.queue = this.queue.filter((cmd) => cmd.dueTick > this.tick);
  };
  while (!sim.ended) {
    while (index < inputs.length && inputs[index].issuedTick <= sim.tick) {
      sim.queue.push({ ...inputs[index++] });
    }
    sim.step();
  }
  return sim;
}

export function analyzeOrderSensitivity(recording) {
  const p1Wins = runWithOrderPolicy(recording, 'P1');
  const p2Wins = runWithOrderPolicy(recording, 'P2');
  const hashP1 = hashObject(p1Wins.snapshot());
  const hashP2 = hashObject(p2Wins.snapshot());

  const report = recording.timeline.conflicts.map((conflict) => {
    const metricAt = recording.timeline.metrics.find((m) => m.tick === conflict.tick);
    return {
      tick: conflict.tick,
      simTime: conflict.simTime,
      object: conflict.object,
      position: conflict.position,
      players: conflict.players,
      commands: conflict.commands,
      values: conflict.values,
      orderSensitive: conflict.orderSensitive,
      channelLevelAtTick: metricAt ? metricAt.channel : null,
      note: conflict.note
    };
  });

  return {
    conflicts: report,
    reorderDiverges: hashP1 !== hashP2,
    finalHashIfP1Wins: hashP1,
    finalHashIfP2Wins: hashP2,
    endingP1First: p1Wins.ended,
    endingP2First: p2Wins.ended
  };
}

export function summarizeRecording(recording) {
  const metrics = recording.timeline.metrics;
  const last = metrics[metrics.length - 1] || {};
  const peak = metrics.reduce(
    (acc, m) => (m.pressure > acc.pressure ? { tick: m.tick, t: m.t, pressure: m.pressure } : acc),
    { tick: 0, t: 0, pressure: 0 }
  );
  return {
    scenario: recording.scenario,
    ticks: metrics.length,
    inputCount: recording.timeline.inputs.length,
    eventCount: recording.timeline.events.length,
    conflictCount: recording.timeline.conflicts.length,
    collisionCount: recording.timeline.events.filter((e) => e.type === 'structural_collision').length,
    overheatCount: recording.timeline.events.filter((e) => e.type === 'pump_overheat').length,
    peakPressure: peak,
    finalStreetDepth: last.street || 0,
    finalDurability: last.durability ?? 100,
    finalHash: recording.finalHash
  };
}
