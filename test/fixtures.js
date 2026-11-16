import {
  DEFAULT_AUDIO_OPTIONS,
  generateChunks,
  PyramidBuilder,
  TileCache,
  NoticeBus,
  createProject
} from "../src/index.js";

let tenMinutePyramidPromise = null;

export const VIEW = Object.freeze({ width: 960, height: 320 });

export function tenMinutePyramid() {
  if (!tenMinutePyramidPromise) {
    const builder = new PyramidBuilder(DEFAULT_AUDIO_OPTIONS.sampleRate);
    tenMinutePyramidPromise = (async () => {
      await generateChunks(DEFAULT_AUDIO_OPTIONS, async (chunk) =>
      builder.pushChunk(chunk)
      );
      return builder.build();
    })();
  }
  return tenMinutePyramidPromise;
}

export function defaultProject(overrides = {}) {
  return createProject({
    width: VIEW.width,
    height: VIEW.height,
    audio: {
      sampleRate: DEFAULT_AUDIO_OPTIONS.sampleRate,
      durationSec: DEFAULT_AUDIO_OPTIONS.durationSec,
      seed: DEFAULT_AUDIO_OPTIONS.seed
    },
    ...overrides
  });
}

export function resolvingCache(value = { ready: true }) {
  return new TileCache(async () => value, { notices: new NoticeBus() });
}

export function failingCache(notices = new NoticeBus()) {
  return new TileCache(async () => {
    throw new Error("Simulated async request failure");
  }, { notices });
}
