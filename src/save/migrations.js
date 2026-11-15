// Save payload format versions. Every migration is pure data-in/data-out and
// chained, so an old save can be upgraded step by step to CURRENT_VERSION.
export const CURRENT_VERSION = 3;
export const MIN_SUPPORTED_VERSION = 1;

function v1ToV2(payload) {
  // v1 stored sound volume as 0..100; v2 normalised it to 0..1 and added a
  // named difficulty level.
  const settings = payload.settings ?? {};
  const migrated = {
    ...payload,
    settings: {
      ...settings,
      volume:
        typeof settings.volume === "number" && settings.volume > 1
          ? settings.volume / 100
          : settings.volume ?? 0.7,
      difficulty: settings.difficulty ?? "normal",
    },
  };
  return migrated;
}

function v2ToV3(payload) {
  // v3 adds the recent replay summary and replaces the flat "gems" progress
  // counter with an explicit collected-coordinate list.
  const progress = payload.progress ?? {};
  const collected = Array.isArray(progress.collected)
    ? progress.collected
    : new Array(progress.gems ?? 0)
        .fill(0)
        .map((_, index) => [-1 - index, -1]);
  return {
    ...payload,
    progress: {
      ...progress,
      collected,
    },
    replaySummary: payload.replaySummary ?? {
      capacity: 20,
      count: 0,
      totalSteps: 0,
      totalGems: collected.length,
      lastAction: null,
      recent: [],
    },
  };
}

const MIGRATIONS = {
  1: v1ToV2,
  2: v2ToV3,
};

export class UnsupportedVersionError extends Error {
  constructor(version) {
    super(
      "Unsupported save version " +
        version +
        "; this build supports v" +
        MIN_SUPPORTED_VERSION +
        "..v" +
        CURRENT_VERSION,
    );
    this.name = "UnsupportedVersionError";
    this.version = version;
  }
}

export function migrate(payload, envelopeVersion) {
  let current = payload;
  let version = envelopeVersion;
  const trail = [version];
  if (
    typeof version !== "number" ||
    version < MIN_SUPPORTED_VERSION ||
    version > CURRENT_VERSION
  ) {
    throw new UnsupportedVersionError(version);
  }
  while (version < CURRENT_VERSION) {
    const migrateStep = MIGRATIONS[version];
    current = migrateStep(current);
    version++;
    trail.push(version);
  }
  return { payload: current, trail };
}
