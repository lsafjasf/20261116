import {
  WORLD, ROADS, DANGERS, SAFE_ROUTES,
  nearestRoad, nearestDanger, distToSegment
} from './world.js';

export function createInitialState() {
  return {
    clock: 0,
    seq: 0,
    markerSeq: 0,
    routeSeq: 0,
    score: 0,
    status: 'running',
    endReason: null,
    verifiedDangers: [],
    routeDraft: [],
    markers: [],
    routes: [],
    timeline: [],
    stats: {
      duplicateAttempts: 0,
      offRoadAttempts: 0,
      consecutivePenalties: 0,
      verifierRejections: 0,
      blockedRoutes: 0,
      durabilityHits: 0
    },
    players: {
      left: {
        id: 'left', role: 'marker', score: 0, durability: WORLD.startDurability,
        streakRoad: null, streak: 0, markersPlaced: 0, undos: 0
      },
      right: {
        id: 'right', role: 'verifier', score: 0, durability: WORLD.startDurability,
        verifications: 0, rejections: 0, waypoints: 0, acceptedRoutes: 0
      }
    }
  };
}

function nextId(state, prefix) {
  if (prefix === 'M') {
    state.markerSeq += 1;
    return `M${state.markerSeq}`;
  }
  state.routeSeq += 1;
  return `T${state.routeSeq}`;
}

function record(state, event, result) {
  event.seq = state.timeline.length + 1;
  event.result = result;
  state.timeline.push(event);
}

function durabilityHit(state, side, amount) {
  const player = state.players[side];
  player.durability = Math.max(0, player.durability - amount);
  state.stats.durabilityHits += 1;
  if (player.durability === 0 && state.status === 'running') {
    state.status = 'failed';
    state.endReason = `durability:${side}`;
  }
}

function checkWin(state) {
  if (state.status !== 'running') return;
  const accepted = state.routes.filter((route) => route.accepted === true).length;
  if (state.verifiedDangers.length === DANGERS.length && accepted >= 2) {
    state.status = 'won';
    state.endReason = 'all_objectives_complete';
  }
}

function placeMarker(state, event) {
  const player = state.players.left;
  const hit = nearestRoad(event.x, event.y);
  if (hit.distance > WORLD.snapRadius) {
    state.stats.offRoadAttempts += 1;
    player.score -= 5;
    state.score -= 5;
    durabilityHit(state, 'left', 8);
    return { accepted: false, reason: 'off_road' };
  }
  const duplicate = state.markers.find(
    (marker) => Math.hypot(marker.x - event.x, marker.y - event.y) <= WORLD.snapRadius
  );
  if (duplicate) {
    state.stats.duplicateAttempts += 1;
    player.score -= 2;
    state.score -= 2;
    durabilityHit(state, 'left', 4);
    return { accepted: false, reason: 'duplicate', conflictId: duplicate.id };
  }
  const dangerHit = nearestDanger(event.x, event.y);
  const dangerId = dangerHit.distance <= WORLD.snapRadius ? dangerHit.danger.id : null;
  const roadId = hit.road.id;
  let points = 10;
  if (player.streakRoad === roadId) {
    player.streak += 1;
    points = Math.max(1, 10 - 5 * (player.streak - 1));
    state.stats.consecutivePenalties += 10 - points;
  } else {
    player.streakRoad = roadId;
    player.streak = 1;
  }
  const marker = {
    id: nextId(state, 'M'), owner: 'left', roadId, dangerId,
    x: event.x, y: event.y, verified: false, rejected: false,
    verifiedBy: null, createdAt: event.t
  };
  state.markers.push(marker);
  player.markersPlaced += 1;
  player.score += points;
  state.score += points;
  return { accepted: true, markerId: marker.id, roadId, dangerId, points };
}

function undo(state, event) {
  if (event.side === 'right') {
    if (state.routeDraft.length === 0) return { accepted: false, reason: 'nothing_to_undo' };
    const removed = state.routeDraft.pop();
    return { accepted: true, kind: 'waypoint', removed };
  }
  const owned = state.markers
    .filter((marker) => marker.owner === 'left' && !marker.verified)
    .pop();
  if (!owned) {
    return { accepted: false, reason: 'no_owned_unverified_marker' };
  }
  state.markers = state.markers.filter((marker) => marker.id !== owned.id);
  state.players.left.undos += 1;
  const rightArtifacts = state.markers.length + state.routes.length + state.routeDraft.length;
  return { accepted: true, kind: 'marker', removedId: owned.id, rightArtifactsKept: rightArtifacts };
}

function verify(state, event) {
  const player = state.players.right;
  const marker = state.markers.find((item) => item.id === event.markerId);
  if (!marker) return { accepted: false, reason: 'marker_not_found' };
  if (marker.verified) return { accepted: false, reason: 'already_verified' };
  marker.verifiedBy = 'right';
  marker.verifiedAt = event.t;
  if (!event.approve) {
    marker.rejected = true;
    player.rejections += 1;
    state.stats.verifierRejections += 1;
    player.score -= 5;
    state.score -= 5;
    durabilityHit(state, 'right', 10);
    return { accepted: true, approved: false, markerId: marker.id };
  }
  marker.verified = true;
  player.verifications += 1;
  player.score += 15;
  state.score += 15;
  let newlyVerifiedDanger = false;
  if (marker.dangerId && !state.verifiedDangers.includes(marker.dangerId)) {
    state.verifiedDangers.push(marker.dangerId);
    newlyVerifiedDanger = true;
  }
  checkWin(state);
  return { accepted: true, approved: true, markerId: marker.id, newlyVerifiedDanger };
}

function addWaypoint(state, event) {
  const hit = nearestRoad(event.x, event.y);
  if (hit.distance > WORLD.snapRadius) {
    durabilityHit(state, 'right', 6);
    return { accepted: false, reason: 'off_road' };
  }
  state.routeDraft.push([event.x, event.y]);
  state.players.right.waypoints += 1;
  return { accepted: true, index: state.routeDraft.length - 1, roadId: hit.road.id };
}

function routeHitsDanger(points) {
  const hits = [];
  for (const danger of DANGERS) {
    for (let i = 0; i < points.length - 1; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      if (distToSegment(danger.x, danger.y, x1, y1, x2, y2) <= WORLD.dangerClearance) {
        hits.push(danger.id);
        break;
      }
    }
  }
  return hits;
}

function finishRoute(state, event) {
  const player = state.players.right;
  if (state.routeDraft.length < 2) return { accepted: false, reason: 'route_too_short' };
  const points = state.routeDraft.map((point) => [...point]);
  const hitDangerIds = routeHitsDanger(points);
  const route = {
    id: nextId(state, 'T'), owner: 'right', name: event.name || '未命名路线',
    points, hitDangerIds, accepted: hitDangerIds.length === 0,
    finishedAt: event.t
  };
  state.routes.push(route);
  state.routeDraft = [];
  if (route.accepted) {
    player.acceptedRoutes += 1;
    player.score += 40;
    state.score += 40;
    checkWin(state);
  } else {
    state.stats.blockedRoutes += 1;
    player.score -= 10;
    state.score -= 10;
    durabilityHit(state, 'right', 25);
  }
  return { accepted: route.accepted, routeId: route.id, hitDangerIds };
}

export function applyEvent(state, rawEvent) {
  const event = { ...rawEvent };
  event.t = event.t ?? state.clock;
  let result;
  switch (event.type) {
    case 'tick':
      state.clock += event.dt;
      if (state.clock >= WORLD.durationMs && state.status === 'running') {
        state.status = 'failed';
        state.endReason = 'timeout';
      }
      result = { accepted: true, clock: state.clock };
      break;
    case 'zoom':
      result = { accepted: true, side: event.side, scale: event.scale };
      break;
    case 'placeMarker':
      result = placeMarker(state, event);
      break;
    case 'undo':
      result = undo(state, event);
      break;
    case 'verify':
      result = verify(state, event);
      break;
    case 'addWaypoint':
      result = addWaypoint(state, event);
      break;
    case 'finishRoute':
      result = finishRoute(state, event);
      break;
    default:
      result = { accepted: false, reason: 'unknown_event' };
  }
  record(state, event, result);
  return result;
}

export function replay(events) {
  const state = createInitialState();
  for (const event of events) applyEvent(state, event);
  return state;
}

export { ROADS, DANGERS, SAFE_ROUTES, WORLD };
