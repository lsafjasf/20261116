/* Generates deterministic keyframe test files:
 *   testdata/keyframes_valid.json  - 100k well-formed keyframes
 *   testdata/keyframes_broken.json - same, but object #51234 has a
 *                                    schema violation at position[1]
 * Usage: node tools/gen_data.js [count] */
"use strict";
const fs = require("fs");
const path = require("path");

const COUNT = Number(process.argv[2]) || 100000;
const BIG_COUNT = 400000; // used by the cancel-path acceptance test
const BAD_INDEX = 51234;
const OUT_DIR = path.join(__dirname, "..", "testdata");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EASINGS = ["linear", "ease-in", "ease-out", "ease-in-out", "step"];
const BONES = ["root", "spine", "arm.L", "arm.R", "leg.L", "leg.R", "head", "hand.L"];

function keyframe(rand, i) {
  const num = (scale) => Number((rand() * scale - scale / 2).toFixed(4));
  return {
    id: i,
    time: Number((i * 0.0333).toFixed(4)),
    position: [num(10), num(10), num(10)],
    rotation: [num(1), num(1), num(1), Number((rand()).toFixed(4))],
    meta: {
      bone: BONES[Math.floor(rand() * BONES.length)],
      easing: EASINGS[Math.floor(rand() * EASINGS.length)]
    }
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
function write(name, broken, count) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, build(broken, count));
  const size = fs.statSync(file).size;
  console.log(`${name}: ${count} keyframes, ${(size / 1048576).toFixed(1)} MiB` +
    (broken ? ` (schema error at keyframes[${BAD_INDEX}].position[1])` : ""));
}
function build(broken, count) {
  const rand = mulberry32(20261116);
  const parts = ["["];
  for (let i = 0; i < count; i++) {
    const kf = keyframe(rand, i);
    if (broken && i === BAD_INDEX) {
      kf.position[1] = "oops"; // schema violation: string where number expected
    }
    parts.push((i === 0 ? "" : ",") + JSON.stringify(kf));
  }
  parts.push("]");
  return parts.join("");
}
write("keyframes_valid.json", false, COUNT);
write("keyframes_broken.json", true, COUNT);
write("keyframes_big.json", false, BIG_COUNT);
