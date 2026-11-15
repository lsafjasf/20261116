// 生成可复核的导出物：3 个 CSV、热图 PNG（零依赖编码器）、可重载工程 JSON
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { sanitizeDataset } from '../src/graph.js';
import { runSimulation } from '../src/simulation.js';
import { sampleB, recommendedClosureB } from '../src/samples/sample-b.js';
import { buildCsvBundle, verifyExport } from '../src/exporter.js';
import { buildProject } from '../src/project.js';

const outDir = path.resolve('exports');
mkdirSync(outDir, { recursive: true });
const clean = sanitizeDataset(sampleB);
const result = runSimulation(clean.data, { closures: [recommendedClosureB] });
const bundle = buildCsvBundle(result);
const verify = verifyExport(result, bundle);

writeFileSync(path.join(outDir, 'vehicles_sample-b-closure.csv'), bundle.vehiclesCsv);
writeFileSync(path.join(outDir, 'events_sample-b-closure.csv'), bundle.eventsCsv);
writeFileSync(path.join(outDir, 'heatmap_sample-b-closure.csv'), bundle.heatmapCsv);

const project = buildProject({
  sampleId: clean.data.id,
  dataset: clean.data,
  sanitizeIssues: clean.issues,
  overrides: { weights: {}, closures: [recommendedClosureB] },
  filters: { state: 'all', vehicleId: '' },
  selectedVehicleId: 'K1',
  selectedEdgeId: 'AB',
  heatmapEnabled: true,
  dataVersion: 2,
});
writeFileSync(path.join(outDir, 'project_sample-b-closure.json'), JSON.stringify(project, null, 2));

// ---- 零依赖 PNG 编码：将热图栅格化到离屏像素缓冲 ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const W = 720;
const H = 420;
const pixels = Buffer.alloc(W * H * 4, 15); // 深色背景
for (let i = 0; i < pixels.length; i += 4) { pixels[i + 2] = 32; pixels[i + 3] = 255; }
const heatById = new Map(result.heatmap.map((h) => [h.id, h]));
const setPx = (x, y, r, g, b) => {
  const ix = Math.round(x); const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
  const o = (iy * W + ix) * 4;
  pixels[o] = r; pixels[o + 1] = g; pixels[o + 2] = b;
};
const line = (x1, y1, x2, y2, color, thick) => {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    for (let dx = -thick; dx <= thick; dx += 1) setPx(x + dx, y, ...color);
  }
};
for (const edge of result.graph.edgeById.values()) {
  const a = result.graph.nodeById.get(edge.from);
  const b = result.graph.nodeById.get(edge.to);
  const ratio = Math.min(1, heatById.get(edge.id)?.ratio || 0);
  line(a.x, a.y, b.x, b.y, [Math.round(255 * ratio), Math.round(180 * (1 - ratio)), 60], 2);
}
for (const node of result.graph.nodeById.values()) {
  for (let dx = -5; dx <= 5; dx += 1) for (let dy = -5; dy <= 5; dy += 1) {
    if (dx * dx + dy * dy <= 25) setPx(node.x + dx, node.y + dy, 214, 226, 240);
  }
}
writeFileSync(path.join(outDir, 'heatmap_sample-b-closure.png'), encodePng(W, H, pixels));

console.log('导出物已生成到 exports/');
console.log('一致性校验：', verify.pass ? 'PASS' : 'FAIL');
console.log(JSON.stringify(verify.scope, null, 2));
