import { ingestRecords } from './ingest.js';
import { TimelineModel } from './timeline.js';

export function buildProject(sample) {
  const ingested = ingestRecords(sample);
  return {
    model: new TimelineModel({
      projectId: sample.sampleId,
      name: sample.name,
      totalDurationMs: sample.totalDurationMs,
      clips: ingested.clips,
      issues: ingested.issues,
      ingestStats: ingested.stats,
      outlierDiagnostics: ingested.outlierDiagnostics,
    }),
    ingested,
  };
}
