import { digest } from "./hash.js";

const CJK_RE = /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u;
const SPACE_RE = /\s/u;
export const OPENING_PUNCTUATION = Array.from("（(【[「『《〈〔｛{“‘");
export const CLOSING_PUNCTUATION = Array.from("）)】]」』》〉〕｝}，,。.、；;：:！!？?…—·%’”");
const OPENING = new Set(OPENING_PUNCTUATION);
const CLOSING = new Set(CLOSING_PUNCTUATION);
const EPSILON = 0.001;
const GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && Intl.Segmenter
    ? new Intl.Segmenter("en", { granularity: "grapheme" })
    : null;

export const DEFAULT_STYLE = Object.freeze({
  fontFamily: "sans-serif",
  fontWeight: 600,
  fontSize: 32,
  width: 680,
  align: "center",
  lineHeight: 1.5
});

export function normalizeStyle(style = {}) {
  return {
    fontFamily: String(style.fontFamily || DEFAULT_STYLE.fontFamily),
    fontWeight: Number(style.fontWeight || DEFAULT_STYLE.fontWeight),
    fontSize: Math.max(8, Number(style.fontSize) || DEFAULT_STYLE.fontSize),
    width: Math.max(80, Number(style.width) || DEFAULT_STYLE.width),
    align: ["left", "center", "right"].includes(style.align) ? style.align : "center",
    lineHeight: Math.max(1.05, Number(style.lineHeight) || DEFAULT_STYLE.lineHeight)
  };
}

function isCjk(char) {
  return CJK_RE.test(char);
}

function appendToLast(atoms, text) {
  for (let index = atoms.length - 1; index >= 0; index -= 1) {
    if (atoms[index].break) break;
    atoms[index].text += text;
    return;
  }
  atoms.push({ text, gapBefore: false, kind: "punctuation" });
}

export function tokenize(text) {
  const atoms = [];
  let word = "";
  let wordGap = false;
  let pendingOpening = "";
  let gapBefore = false;

  const flushWord = () => {
    if (!word) return;
    atoms.push({ text: pendingOpening + word, gapBefore: wordGap, kind: "word" });
    word = "";
    wordGap = false;
    pendingOpening = "";
  };

  const pushAtom = (value, gap) => {
    atoms.push({
      text: pendingOpening + value,
      gapBefore: gap || gapBefore,
      kind: "cjk"
    });
    pendingOpening = "";
    gapBefore = false;
  };

  for (const char of Array.from(text)) {
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text.includes("\r\n")) continue;
      flushWord();
      atoms.push({ break: true });
      gapBefore = false;
      continue;
    }
    if (SPACE_RE.test(char)) {
      flushWord();
      gapBefore = true;
      continue;
    }
    if (OPENING.has(char)) {
      flushWord();
      pendingOpening += char;
      continue;
    }
    if (CLOSING.has(char)) {
      if (word) {
        word += char;
        flushWord();
        gapBefore = false;
      } else if (pendingOpening) {
        atoms.push({ text: pendingOpening + char, gapBefore, kind: "punctuation" });
        pendingOpening = "";
        gapBefore = false;
      } else {
        appendToLast(atoms, char);
        gapBefore = false;
      }
      continue;
    }
    if (isCjk(char)) {
      flushWord();
      pushAtom(char, gapBefore);
      continue;
    }
    if (!word) wordGap = gapBefore;
    word += char;
    gapBefore = false;
  }

  flushWord();
  if (pendingOpening) appendToLast(atoms, pendingOpening);
  return atoms;
}

function graphemeUnits(text) {
  if (GRAPHEME_SEGMENTER) {
    return Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

function splitToWidth(text, width, measure) {
  const chunks = [];
  let current = "";
  let currentWidth = 0;
  for (const unit of graphemeUnits(text)) {
    const unitWidth = measure(unit);
    if (current && currentWidth + unitWidth > width + EPSILON) {
      let carry = "";
      let carryWidth = 0;
      const currentUnits = graphemeUnits(current);
      const lastText = currentUnits[currentUnits.length - 1] || "";
      const carryStart = CLOSING.has(unit)
        ? currentUnits.findLastIndex((value) => !CLOSING.has(value))
        : -1;
      if (carryStart >= 0) {
        const candidate = currentUnits.slice(carryStart).join("");
        const candidateWidth = measure(candidate);
        if (candidateWidth + unitWidth <= width + EPSILON) {
          carry = candidate;
          carryWidth = candidateWidth;
          current = currentUnits.slice(0, carryStart).join("");
          currentWidth -= carryWidth;
        }
      } else if (OPENING.has(lastText)) {
        carry = lastText;
        carryWidth = measure(lastText);
        current = currentUnits.slice(0, -1).join("");
        currentWidth -= carryWidth;
      }
      if (current) chunks.push({ text: current, width: currentWidth });
      current = carry + unit;
      currentWidth = carryWidth + unitWidth;
    } else {
      current += unit;
      currentWidth += unitWidth;
    }
  }
  if (current || chunks.length === 0) chunks.push({ text: current, width: currentWidth });
  return chunks;
}

function firstUnit(text) {
  return graphemeUnits(text)[0] || "";
}

function lastUnit(text) {
  const units = graphemeUnits(text);
  return units[units.length - 1] || "";
}

function enforceKinsoku(lines, width, measure) {
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (let index = 1; index < lines.length; index += 1) {
      const unit = firstUnit(lines[index].text);
      if (unit && CLOSING.has(unit)) {
        const unitWidth = measure(unit);
        if (lines[index - 1].width + unitWidth <= width + EPSILON) {
          lines[index - 1].text += unit;
          lines[index].text = lines[index].text.slice(unit.length);
          lines[index - 1].width = measure(lines[index - 1].text);
          lines[index].width = measure(lines[index].text);
          changed = true;
        }
      }
    }
    for (let index = 0; index < lines.length - 1; index += 1) {
      const unit = lastUnit(lines[index].text);
      if (unit && OPENING.has(unit)) {
        const unitWidth = measure(unit);
        if (lines[index + 1].width + unitWidth <= width + EPSILON) {
          lines[index + 1].text = unit + lines[index + 1].text;
          lines[index].text = lines[index].text.slice(0, -unit.length);
          lines[index + 1].width = measure(lines[index + 1].text);
          lines[index].width = measure(lines[index].text);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

function alignX(lineWidth, width, align) {
  if (align === "right") return width - lineWidth;
  if (align === "center") return (width - lineWidth) / 2;
  return 0;
}

export function layoutText(input, rawStyle, measure) {
  const style = normalizeStyle(rawStyle);
  const text = String(input ?? "").replace(/\r\n?/g, "\n");
  let candidateCount = 0;
  const measureWithCount = (value) => {
    candidateCount += 1;
    return Math.max(0, Number(measure(value, style)) || 0);
  };

  const atoms = tokenize(text);
  const rawLines = [];
  let tokens = [];
  let lineWidth = 0;
  let spaceWidth = null;
  let endedWithBreak = false;

  const getSpaceWidth = () => {
    if (spaceWidth === null) spaceWidth = measureWithCount(" ");
    return spaceWidth;
  };

  const flush = () => {
    rawLines.push({
      text: tokens.map((token) => token.text).join(""),
      width: lineWidth
    });
    tokens = [];
    lineWidth = 0;
  };

  for (const atom of atoms) {
    if (atom.break) {
      flush();
      endedWithBreak = true;
      continue;
    }
    if (!atom.text) continue;
    endedWithBreak = false;
    const atomWidth = measureWithCount(atom.text);
    const gapWidth = tokens.length && atom.gapBefore ? getSpaceWidth() : 0;

    if (atomWidth > style.width) {
      if (tokens.length) flush();
      const chunks = splitToWidth(atom.text, style.width, measureWithCount);
      chunks.forEach((chunk, index) => {
        if (index < chunks.length - 1) {
          rawLines.push({ text: chunk.text, width: chunk.width });
        } else {
          tokens = [{ text: chunk.text, width: chunk.width }];
          lineWidth = chunk.width;
        }
      });
      continue;
    }

    if (tokens.length && lineWidth + gapWidth + atomWidth > style.width + EPSILON) {
      flush();
      tokens = [{ text: atom.text, width: atomWidth }];
      lineWidth = atomWidth;
      continue;
    }

    if (gapWidth) {
      tokens.push({ text: " ", width: gapWidth });
      lineWidth += gapWidth;
    }
    tokens.push({ text: atom.text, width: atomWidth });
    lineWidth += atomWidth;
  }

  if (tokens.length || rawLines.length === 0 || endedWithBreak) flush();
  enforceKinsoku(rawLines, style.width, measureWithCount);

  const lineHeight = style.fontSize * style.lineHeight;
  const lines = rawLines.map((line, index) => ({
    text: line.text,
    width: line.width,
    x: alignX(line.width, style.width, style.align),
    y: index * lineHeight,
    height: lineHeight
  }));

  return {
    text,
    style,
    width: style.width,
    lineHeight,
    height: lines.length * lineHeight,
    lines,
    candidateCount
  };
}

export function layoutString(layout) {
  return layout.lines.map((line) => line.text).join("\n");
}

export function layoutFingerprint(layout) {
  return digest({
    width: layout.width,
    lineHeight: layout.lineHeight,
    lines: layout.lines.map((line) => ({
      text: line.text,
      x: Math.round(line.x * 1000) / 1000,
      y: Math.round(line.y * 1000) / 1000,
      width: Math.round(line.width * 1000) / 1000
    }))
  });
}
