import { FabricMaterial } from "../js/core/material.js";
import { checkSeams, hashBytes } from "../js/core/analysis.js";
import { DEFAULT_PARAMS } from "../js/core/params.js";
const t0 = performance.now();
const m = new FabricMaterial(DEFAULT_PARAMS);
const t1 = performance.now();
console.log("render ms", (t1 - t0).toFixed(1));
console.log("hash", hashBytes(m.composite));
console.log("seams", checkSeams(m.composite));
