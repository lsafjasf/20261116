import "./dom-shim.mjs";
import { runAll } from "../js/ui/harness.js";
const results=runAll();
for(const r of results) console.log(r.pass?"PASS":"FAIL", r.el.children[0].children[0].textContent);
if(results.some(r=>!r.pass)) process.exit(1);
