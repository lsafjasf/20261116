import test from "node:test";
import assert from "node:assert/strict";
import { LayoutEngine } from "../src/engine.js";
import { createApproxMeasurer } from "../src/measure.js";
import {
  CLOSING_PUNCTUATION,
  OPENING_PUNCTUATION,
  layoutText,
  layoutString
} from "../src/layout.js";
import { findOverlaps, lineRects, maxScroll } from "../src/geometry.js";

const engine = new LayoutEngine(createApproxMeasurer());
const closing = new Set(CLOSING_PUNCTUATION);
const opening = new Set(OPENING_PUNCTUATION);
const units = (value) => Array.from(value);

test("CJK lines never begin with closing punctuation or end with opening punctuation", () => {
  const text = "「引号」、《书名》、（括号）——中文避头尾必须保持正确，句号也不能掉队！";
  for (const width of [120, 180, 240, 320, 480]) {
    const layout = layoutText(text, { width, fontSize: 26, align: "center" }, engine.measure);
    for (let index = 1; index < layout.lines.length; index += 1) {
      const first = units(layout.lines[index].text)[0];
      assert.equal(closing.has(first), false, `${width}px line ${index} starts with ${first}`);
    }
    for (let index = 0; index < layout.lines.length - 1; index += 1) {
      const line = layout.lines[index].text;
      const last = units(line)[units(line).length - 1];
      assert.equal(opening.has(last), false, `${width}px line ${index} ends with ${last}`);
    }
  }
});

test("normal English words wrap at spaces without fragmenting", () => {
  const text = "Good typography keeps every word intact under pressure.";
  const words = new Set(text.replace(/\./g, "").split(/\s+/));
  const layout = layoutText(text, { width: 300, fontSize: 24, align: "left" }, engine.measure);
  for (const line of layout.lines) {
    for (const token of line.text.split(/\s+/).filter(Boolean)) {
      assert.equal(words.has(token.replace(/[.,—]/g, "")), true, `fragment: ${token}`);
    }
  }
  assert.equal(layout.lines.map((line) => line.text).join(" ").replace(/\s+/g, " "), text);
});

test("overlong English words split only when they cannot fit", () => {
  const word = "Pneumonoultramicroscopicsilicovolcanoconiosis";
  const wide = layoutText(word, { width: 900, fontSize: 24 }, engine.measure);
  assert.equal(wide.lines.length, 1);
  assert.equal(wide.lines[0].text, word);
  const narrow = layoutText(word, { width: 140, fontSize: 24 }, engine.measure);
  assert.ok(narrow.lines.length > 1);
  assert.equal(narrow.lines.map((line) => line.text).join(""), word);
  for (const line of narrow.lines) assert.ok(line.width <= 140.001);
});

test("alignment computes stable x offsets", () => {
  const style = { width: 500, fontSize: 30, align: "left" };
  const left = layoutText("Short line", style, engine.measure);
  assert.equal(left.lines[0].x, 0);
  const center = layoutText("Short line", { ...style, align: "center" }, engine.measure);
  assert.ok(Math.abs(center.lines[0].x - (500 - center.lines[0].width) / 2) < 1e-9);
  const right = layoutText("Short line", { ...style, align: "right" }, engine.measure);
  assert.ok(Math.abs(right.lines[0].x - (500 - right.lines[0].width)) < 1e-9);
});

test("forced breaks and empty text preserve line structure", () => {
  const layout = layoutText("first\nsecond\n", { width: 400, fontSize: 20 }, engine.measure);
  assert.deepEqual(layout.lines.map((line) => line.text), ["first", "second", ""]);
  assert.deepEqual(layoutText("", {}, engine.measure).lines.map((line) => line.text), [""]);
});

test("line strings retain all visible CJK and English content", () => {
  const text = "缓存布局必须保留中文避头尾与 English word wrapping。";
  const layout = layoutText(text, { width: 260, fontSize: 28 }, engine.measure);
  const joined = layout.lines.map((line) => line.text).join("").replace(/\s+/g, "");
  assert.equal(joined, text.replace(/\s+/g, ""));
  assert.equal(layoutString(layout), layout.lines.map((line) => line.text).join("\n"));
});

test("mixed realistic text respects width and kinsoku at many measures", () => {
  const phrases = [
    "缓存不是魔法",
    "中文避头尾",
    "句号跟着上一行",
    "括号也不能被拆开",
    "滚动缩放保持稳定",
    "English word wrapping",
    "layout cache hit rate",
    "Good typography"
  ];
  const punctuation = ["，", "。", "！", "？", "；", "：", "、", "」", "）", "》"];
  let seed = 5;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  for (let sample = 0; sample < 300; sample += 1) {
    let text = "";
    for (let part = 0; part < 4; part += 1) {
      text += phrases[Math.floor(random() * phrases.length)];
      if (random() < 0.6) text += punctuation[Math.floor(random() * punctuation.length)];
    }
    for (const width of [120, 180, 240, 320, 480]) {
      const layout = layoutText(text, { width, fontSize: 24 }, engine.measure);
      for (const line of layout.lines) {
        assert.ok(line.width <= width + 0.001, `${line.text} exceeds ${width}`);
      }
      for (let index = 1; index < layout.lines.length; index += 1) {
        const first = units(layout.lines[index].text)[0];
        assert.equal(closing.has(first), false, `line starts ${first}`);
      }
      for (let index = 0; index < layout.lines.length - 1; index += 1) {
        const textLine = layout.lines[index].text;
        const last = units(textLine)[units(textLine).length - 1];
        assert.equal(opening.has(last), false, `line ends ${last}`);
      }
    }
  }
});

test("scroll and zoom projections never overlap line rectangles", () => {
  const layout = layoutText(
    "滚动和缩放只改变屏幕变换，不改变排版节点。Scroll and zoom must never overlap.",
    { width: 260, fontSize: 30, lineHeight: 1.2 },
    engine.measure
  );
  for (const zoom of [0.5, 0.8, 1, 1.5, 2.5]) {
    for (const scroll of [0, 0.5, 1]) {
      const scrollPx = maxScroll(layout, zoom, 140) * scroll;
      assert.deepEqual(findOverlaps(lineRects(layout, zoom, scrollPx)), []);
    }
  }
});
