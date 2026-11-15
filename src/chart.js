// Deterministic chart generation so snapshots can reproduce beat points.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Notes are expressed in beat indices starting at beat 2 (giving lead-in time).
export function generateChart(params) {
  const { bpm, beats, swing } = params;
  const beatDur = 60 / bpm;
  const rand = mulberry32(20261116);
  const notes = [];
  let serial = 0;
  const leadInBeats = 2;

  for (let beat = leadInBeats; beat < beats; beat += 1) {
    // One note per beat on a rotating lane, plus an offbeat note every 4th beat.
    const laneA = beat % 4;
    notes.push(makeNote(serial++, beat * beatDur, laneA, beat));

    if (beat % 4 === 2) {
      const laneB = (laneA + 1 + Math.floor(rand() * 2)) % 4;
      const offbeat = (beat + 0.5 + (swing ? swing * 0.5 : 0)) * beatDur;
      notes.push(makeNote(serial++, offbeat, laneB, beat + 0.5));
    }
  }
  notes.sort((a, b) => a.time - b.time);
  return {
    version: 1,
    bpm,
    beatDur,
    duration: (beats + 1) * beatDur,
    notes,
  };
}

function makeNote(id, time, lane, beat) {
  return {
    id,
    time,            // seconds from chart start, in audio-context clock terms
    lane,
    beat,
    judged: false,
    tier: null,
    hitInputTime: null,
  };
}
