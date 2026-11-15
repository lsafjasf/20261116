import { Recorder, analyzeOrderConflicts } from '../core/timeline.js';
import { DANGERS } from '../core/world.js';

export function buildConflictScenario() {
  const recorder = new Recorder();
  const danger = DANGERS[0];
  recorder.commit({ type: 'tick', dt: 30000, t: 0 });
  recorder.commit({
    type: 'placeMarker', side: 'left', x: danger.x, y: danger.y, t: 30000
  });
  const markerId = recorder.state.markers[0].id;

  recorder.commit({
    type: 'verify', side: 'right', markerId, approve: true, t: 42000
  });
  recorder.commit({ type: 'undo', side: 'left', t: 42000 });

  const conflicts = analyzeOrderConflicts(recorder.state.timeline);
  return { timeline: recorder.state.timeline, conflicts, markerId };
}
