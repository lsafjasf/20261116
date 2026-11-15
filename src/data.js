import { digest } from "./hash.js";

export const CUES = [
  {
    id: "c01",
    start: 0,
    end: 4200,
    speaker: "旁白",
    text: "缓存不是魔法，而是把重复的测量留在上一帧。"
  },
  {
    id: "c02",
    start: 4200,
    end: 8400,
    speaker: "Narrator",
    text: "Good typography keeps every word intact — even under pressure."
  },
  {
    id: "c03",
    start: 8400,
    end: 12600,
    speaker: "旁白",
    text: "中文避头尾：句号必须跟着上一行，括号也不能被拆开。"
  },
  {
    id: "c04",
    start: 12600,
    end: 16800,
    speaker: "Narrator",
    text: "Scroll and zoom are only transforms; the layout stays stable."
  },
  {
    id: "c05",
    start: 16800,
    end: 21000,
    speaker: "旁白",
    text: "「引号」、《书名》、（括号）——都不能错位。"
  }
];

export const FONT_OPTIONS = [
  { value: "system-ui, sans-serif", label: "现代黑体" },
  { value: "Georgia, serif", label: "叙事衬线" },
  { value: "ui-monospace, monospace", label: "等宽字幕" }
];

const commonCues = [
  {
    id: "s1",
    text: "缓存不是魔法，而是把重复的测量留在上一帧。",
    style: {}
  },
  {
    id: "s2",
    text: "Good typography keeps every word intact — even under pressure.",
    style: {}
  },
  {
    id: "s3",
    text: "中文避头尾：句号必须跟着上一行，括号也不能被拆开。",
    style: {}
  },
  {
    id: "s4",
    text: "Scroll and zoom are only transforms; the layout stays stable.",
    style: {}
  },
  {
    id: "s5",
    text: "「引号」、《书名》、（括号）——都不能错位。",
    style: {}
  }
];

const edgeCues = [
  {
    id: "e1",
    text: "Pneumonoultramicroscopicsilicovolcanoconiosis，and（括号）不会掉队。",
    style: { width: 260, fontSize: 26, align: "left" }
  },
  {
    id: "e2",
    text: "「引号开头，引号结尾。」《书名》（括号）——都要留在一起！",
    style: { width: 300, fontSize: 22, align: "center" }
  },
  {
    id: "e3",
    text: "Supercalifragilisticexpialidocious wraps only when it cannot fit.",
    style: { width: 210, fontSize: 24, align: "right", fontFamily: "Georgia, serif" }
  },
  {
    id: "e4",
    text: "缩放到边界时，每一行仍然保持独立，不允许文字互相覆盖。",
    style: { width: 520, fontSize: 40, align: "center", lineHeight: 1.2 }
  },
  {
    id: "e5",
    text: "A very long English sentence under a narrow measure must break between words; antidisestablishmentarianism is the exception.",
    style: { width: 240, fontSize: 20, align: "left", fontWeight: 400 }
  },
  {
    id: "e6",
    text: "末尾标点（不能另起一行），开头括号（也不能悬在行尾）。",
    style: { width: 280, fontSize: 30, align: "right", fontFamily: "ui-monospace, monospace" }
  }
];

const BASE_STYLE = {
  fontFamily: "system-ui, sans-serif",
  fontWeight: 600,
  fontSize: 34,
  width: 680,
  align: "center",
  lineHeight: 1.5
};

export const WORKLOADS = {
  common: {
    id: "common",
    frames: 240,
    holdFrames: 36,
    viewportHeight: 260,
    cues: commonCues,
    style: BASE_STYLE,
    scrollRange: [0.04, 0.96],
    zoomRange: [0.72, 1.72]
  },
  edge: {
    id: "edge",
    frames: 240,
    holdFrames: 24,
    viewportHeight: 230,
    cues: edgeCues,
    style: { ...BASE_STYLE, fontSize: 28, width: 300 },
    scrollRange: [0, 1],
    zoomRange: [0.6, 2]
  }
};

export function frameAt(workload, index) {
  const count = workload.cues.length;
  const cueIndex = Math.floor(index / workload.holdFrames) % count;
  const cue = workload.cues[cueIndex];
  const progress = workload.frames <= 1 ? 0 : index / (workload.frames - 1);
  const wave = 0.5 - 0.5 * Math.cos(progress * Math.PI * 2 + cueIndex * 0.7);
  const scrollNorm =
    workload.scrollRange[0] + (workload.scrollRange[1] - workload.scrollRange[0]) * wave;
  const zoom =
    workload.zoomRange[0] + (workload.zoomRange[1] - workload.zoomRange[0]) * (1 - wave);
  return {
    cueId: cue.id,
    speaker: cue.speaker || "Narrator",
    text: cue.text,
    style: { ...workload.style, ...cue.style },
    scrollNorm,
    zoom
  };
}

export function workloadPublicDigest(workload) {
  return digest({
    id: workload.id,
    frames: workload.frames,
    holdFrames: workload.holdFrames,
    viewportHeight: workload.viewportHeight,
    cues: workload.cues.map((cue) => ({
      id: cue.id,
      text: cue.text,
      style: cue.style
    }))
  });
}

export const SCENARIOS = [
  {
    id: "before",
    label: "优化前",
    description: "常规滚动字幕，关闭缓存，每帧重新测量。",
    workload: WORKLOADS.common,
    cacheEnabled: false
  },
  {
    id: "after",
    label: "优化后",
    description: "同一内容与交互轨迹，开启按样式键控的 LRU 缓存。",
    workload: WORKLOADS.common,
    cacheEnabled: true
  },
  {
    id: "edge",
    label: "边界参数",
    description: "窄宽度、超长英文词、避头尾密集标点、极限缩放。",
    workload: WORKLOADS.edge,
    cacheEnabled: true
  }
];
