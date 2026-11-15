function pending(sim, side, actions) {
  const list = Array.isArray(actions) ? actions : [actions];
  return sim.pending.some(
    (input) => input.side === side && list.includes(input.action)
  );
}

export function createSuccessController() {
  let stressStarted = false;
  let overflowSeen = false;
  let stoppedForOverflow = false;
  let lastScanAt = -10;

  return (sim) => {
    if (!stressStarted && sim.time >= 250) stressStarted = true;
    if (!overflowSeen && sim.overflow.A) overflowSeen = true;
    if (!overflowSeen && sim.overflow.B) overflowSeen = true;

    const queue = sim.frontQueued();
    const scanned = sim.scannedPackage();
    const ahead = sim.beltPackages()[0];
    if (
      queue &&
      !scanned &&
      !pending(sim, 'p1', 'scan') &&
      sim.time - lastScanAt >= 0.7
    ) {
      sim.press('p1', 'scan');
      lastScanAt = sim.time;
    }
    if (
      scanned &&
      !sim.lineStop &&
      !pending(sim, 'p1', 'release') &&
      (!ahead || ahead.x > 342)
    ) {
      sim.press('p1', 'release');
    }

    const routeTarget = sim.routeTarget();
    if (
      routeTarget &&
      !routeTarget.plannedLane &&
      !pending(sim, 'p2', ['laneA', 'laneB'])
    ) {
      sim.press('p2', routeTarget.dest === 'A' ? 'laneA' : 'laneB');
    }

    const shouldPack = !stressStarted || overflowSeen;
    if (
      shouldPack &&
      sim.cacheLoad() > 0 &&
      sim.cooldowns.pack <= sim.time &&
      !pending(sim, 'p2', 'pack')
    ) {
      sim.press('p2', 'pack');
    }

    if (
      sim.durability.p2 < 24 &&
      sim.cooldowns.p2Repair <= sim.time &&
      !pending(sim, 'p2', 'repair')
    ) {
      sim.press('p2', 'repair');
    }
    if (
      sim.durability.p1 < 20 &&
      sim.cooldowns.p1Repair <= sim.time &&
      !pending(sim, 'p1', 'repair')
    ) {
      sim.press('p1', 'repair');
    }

    const overflowActive = Boolean(sim.overflow.A || sim.overflow.B);
    if (
      overflowActive &&
      !sim.lineStop &&
      !pending(sim, 'p1', ['stop', 'resume'])
    ) {
      sim.press('p1', 'stop');
      stoppedForOverflow = true;
    }
    if (
      stoppedForOverflow &&
      sim.lineStop &&
      !overflowActive &&
      sim.cacheLoad() <= 3 &&
      sim.packageById(1) &&
      !pending(sim, 'p1', 'resume')
    ) {
      sim.press('p1', 'resume');
      stoppedForOverflow = false;
    }
  };
}

export function createFailureController() {
  let lastScanAt = -10;
  return (sim) => {
    const queue = sim.frontQueued();
    const scanned = sim.scannedPackage();
    const ahead = sim.beltPackages()[0];
    if (
      queue &&
      !scanned &&
      !pending(sim, 'p1', 'scan') &&
      sim.time - lastScanAt >= 0.7
    ) {
      sim.press('p1', 'scan');
      lastScanAt = sim.time;
    }
    if (
      scanned &&
      !sim.lineStop &&
      !pending(sim, 'p1', 'release') &&
      (!ahead || ahead.x > 342)
    ) {
      sim.press('p1', 'release');
    }
    const target = sim.routeTarget();
    if (target && !target.plannedLane && !pending(sim, 'p2', ['laneA', 'laneB'])) {
      sim.press('p2', target.dest === 'A' ? 'laneA' : 'laneB');
    }
  };
}

export function createContaminationController() {
  let wrongRoutes = 0;
  let lastScanAt = -10;
  return (sim) => {
    const queue = sim.frontQueued();
    const scanned = sim.scannedPackage();
    const ahead = sim.beltPackages()[0];
    if (
      queue &&
      !scanned &&
      !pending(sim, 'p1', 'scan') &&
      sim.time - lastScanAt >= 0.7
    ) {
      sim.press('p1', 'scan');
      lastScanAt = sim.time;
    }
    if (
      scanned &&
      !sim.lineStop &&
      !pending(sim, 'p1', 'release') &&
      (!ahead || ahead.x > 342)
    ) {
      sim.press('p1', 'release');
    }
    const target = sim.routeTarget();
    if (target && !target.plannedLane && !pending(sim, 'p2', ['laneA', 'laneB'])) {
      if (wrongRoutes < 1) {
        sim.press('p2', target.dest === 'A' ? 'laneB' : 'laneA');
        wrongRoutes += 1;
      } else {
        sim.press('p2', target.dest === 'A' ? 'laneA' : 'laneB');
      }
    }
    if (
      sim.cacheLoad() > 0 &&
      sim.cooldowns.pack <= sim.time &&
      !pending(sim, 'p2', 'pack')
    ) {
      sim.press('p2', 'pack');
    }
  };
}

export function runController(sim, controller, maxSeconds = 600) {
  const target = sim.time + maxSeconds;
  while (sim.phase === 'running' && sim.time < target - 1e-7) {
    controller(sim);
    sim.advanceTick();
  }
  return sim;
}
