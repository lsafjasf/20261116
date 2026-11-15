import { Recorder } from '../core/timeline.js';
import { DANGERS, SAFE_ROUTES, BLOCKED_ROUTE } from '../core/world.js';

function advance(recorder, targetClock) {
  const dt = targetClock - recorder.state.clock;
  if (dt > 0) recorder.commit({ type: 'tick', dt, t: recorder.state.clock });
}

function markerIdForDanger(state, dangerId) {
  const marker = state.markers.find((item) => item.dangerId === dangerId && !item.rejected);
  return marker ? marker.id : null;
}

function addRoute(recorder, routeTemplate, startClock, gap) {
  let clock = startClock;
  routeTemplate.points.forEach(([x, y], index) => {
    advance(recorder, clock);
    recorder.commit({ type: 'addWaypoint', side: 'right', x, y, t: clock });
    clock += gap;
  });
  advance(recorder, clock);
  const result = recorder.commit({
    type: 'finishRoute', side: 'right', name: routeTemplate.name, t: clock
  });
  return { result, nextClock: clock + gap };
}

export function runSuccessSession() {
  const recorder = new Recorder();
  advance(recorder, 5000);
  recorder.commit({ type: 'zoom', side: 'left', scale: 1.25, t: 5000 });
  recorder.commit({ type: 'zoom', side: 'right', scale: 0.9, t: 5000 });

  advance(recorder, 10000);
  const d1 = DANGERS[0];
  recorder.commit({ type: 'placeMarker', side: 'left', x: d1.x, y: d1.y, t: 10000 });

  advance(recorder, 15000);
  recorder.commit({ type: 'placeMarker', side: 'left', x: 700, y: 200, t: 15000 });

  advance(recorder, 20000);
  const firstMarkerId = markerIdForDanger(recorder.state, 'D1');
  recorder.commit({ type: 'verify', side: 'right', markerId: firstMarkerId, approve: true, t: 20000 });
  const undoResult = recorder.commit({ type: 'undo', side: 'left', t: 20500 });

  advance(recorder, 25000);
  recorder.commit({ type: 'placeMarker', side: 'left', x: 1000, y: 10, t: 25000 });
  advance(recorder, 30000);
  recorder.commit({ type: 'placeMarker', side: 'left', x: d1.x, y: d1.y, t: 30000 });

  let clock = 35000;
  DANGERS.slice(1).forEach((danger) => {
    advance(recorder, clock);
    recorder.commit({ type: 'placeMarker', side: 'left', x: danger.x, y: danger.y, t: clock });
    clock += 5000;
    advance(recorder, clock);
    const markerId = markerIdForDanger(recorder.state, danger.id);
    recorder.commit({ type: 'verify', side: 'right', markerId, approve: true, t: clock });
    clock += 5000;
  });

  const routeA = addRoute(recorder, SAFE_ROUTES[0], 120000, 2000);
  const routeB = addRoute(recorder, SAFE_ROUTES[1], routeA.nextClock + 5000, 2000);

  return {
    recorder,
    undoResult,
    routeResult: [routeA.result, routeB.result],
    timeline: recorder.state.timeline
  };
}

export function runFailureSession() {
  const recorder = new Recorder();
  const blockedTemplate = { ...BLOCKED_ROUTE, name: BLOCKED_ROUTE.name };
  let clock = 10000;

  for (let round = 0; round < 4; round += 1) {
    advance(recorder, clock);
    const place = recorder.commit({ type: 'placeMarker', side: 'left', x: 450 + round * 40, y: 200, t: clock });
    clock += 3000;
    if (place.accepted) {
      advance(recorder, clock);
      recorder.commit({ type: 'verify', side: 'right', markerId: place.markerId, approve: false, t: clock });
      clock += 3000;
    }
    const blocked = addRoute(recorder, blockedTemplate, clock, 1500);
    clock = blocked.nextClock + 4000;
    if (recorder.state.status !== 'running') break;
  }

  while (recorder.state.status === 'running' && clock < 200000) {
    advance(recorder, clock);
    recorder.commit({ type: 'placeMarker', side: 'left', x: 1000, y: 10, t: clock });
    clock += 5000;
  }

  return { recorder, timeline: recorder.state.timeline };
}

export function runTimeoutSession() {
  const recorder = new Recorder();
  recorder.commit({ type: 'tick', dt: 15 * 60 * 1000, t: 0 });
  return { recorder, timeline: recorder.state.timeline };
}
