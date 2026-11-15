import { writeFile } from "node:fs/promises";
import { TidalSimulation, clockLabel } from "../src/sim.js";

function runStrategy(strategyKey) {
  const sim = new TidalSimulation({ scenarioKey: "normal", strategyKey, seed: 605 });
  sim.complete();
  return {
    strategy: strategyKey,
    result: sim.getResults(),
    reversals: sim.state.counts.reversals,
    finalHash: sim.stateHash,
  };
}

function runIncidentScenario(scenarioKey) {
  const sim = new TidalSimulation({ scenarioKey, strategyKey: "balanced", seed: 605 });
  while (!sim.incidents.length && !sim.ended) sim.step();
  const incident = sim.incidents[0];
  if (!incident) throw new Error(`${scenarioKey}: expected an incident`);
  const incidentSnapshot = {
    id: incident.id,
    type: incident.type,
    title: incident.title,
    tick: incident.tick,
    clock: incident.clock,
    parameter: incident.parameter,
    value: incident.value,
    limit: incident.limit,
    unit: incident.unit,
    margin: incident.margin,
    response: incident.response,
    stateHash: incident.stateHash,
  };
  sim.recoverIncident();
  const auditStartTick = sim.tick;
  sim.runTo(Math.min(720, auditStartTick + sim.audit.required));
  const audit = {
    startTick: auditStartTick,
    startClock: clockLabel(auditStartTick),
    elapsed: sim.audit.elapsed,
    required: sim.audit.required,
    passed: sim.audit.passed,
    violations: sim.audit.violations,
  };
  sim.complete();
  return {
    scenario: scenarioKey,
    incident: incidentSnapshot,
    audit,
    result: sim.getResults(),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  seed: 605,
  period: "06:00-18:00 · 720 deterministic ticks",
  strategies: [runStrategy("balanced"), runStrategy("power")],
  incidents: [runIncidentScenario("bearing"), runIncidentScenario("pressure")],
};

console.log("TIDAL GATE deterministic verification");
console.log("=====================================");
for (const item of report.strategies) {
  const result = item.result;
  console.log(
    `${item.strategy.padEnd(8)} success=${String(result.success).padEnd(5)} ` +
      `energy=${result.energyMWh.toFixed(2)}MWh nav=${result.onTimeNav}/2 ` +
      `incidents=${result.incidents} hash=${result.stateHash}`,
  );
}
for (const item of report.incidents) {
  console.log(
    `${item.incident.clock} ${item.incident.title} ` +
      `margin=${item.incident.margin}${item.incident.unit} ` +
      `audit=${item.audit.elapsed}/${item.audit.required}min ` +
      `passed=${item.audit.passed}`,
  );
}

if (process.argv.includes("--write")) {
  await writeFile(
    new URL("../artifacts/verification.json", import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log("Wrote artifacts/verification.json");
}
