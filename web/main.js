import { DEFAULT_PARAMS } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { LayerStack, Timeline } from '../src/timeline.js';
import { exportFrame } from '../src/project.js';

const params = { ...DEFAULT_PARAMS };
const canvas = document.getElementById('map');
canvas.width = params.viewport.width;
canvas.height = params.viewport.height;
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');
const noticeBox = document.getElementById('notice');

const layers = new LayerStack(params.layers, params.layerColors);
const timeline = new Timeline([
  { t: 0, x: 512, y: 384, zoom: 1 },
  { t: 4000, x: 2400, y: 1600, zoom: 4 },
  { t: 8000, x: 800, y: 3000, zoom: 8 },
  { t: 12000, x: 512, y: 384, zoom: 1 }
]);
const engine = new Engine(params, layers);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    timeline.paused ? timeline.resume() : timeline.pause();
    engine.setPaused(timeline.paused);
  }
  if (e.code === 'KeyE') {
    const cam = timeline.cameraAt(timeline.time);
    console.log('exported frame', exportFrame(engine.render(cam), cam));
  }
});

let last = performance.now();
function frame(now) {
  const dt = Math.min(50, now - last);
  last = now;
  const camera = timeline.advance(dt);
  const ops = engine.update(camera, dt);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const op of ops) {
    ctx.globalAlpha = op.alpha;
    ctx.fillStyle = op.placeholder ? '#555' : op.color;
    ctx.fillRect(op.screen.x, op.screen.y, op.screen.width, op.screen.height);
    ctx.strokeStyle = '#0006';
    ctx.strokeRect(op.screen.x, op.screen.y, op.screen.width, op.screen.height);
  }
  ctx.globalAlpha = 1;
  const s = engine.getStats();
  hud.textContent =
    `cache hits ${s.cache.hits} miss ${s.cache.misses} evict ${s.cache.evictions}\n` +
    `mem ${(s.cache.bytesUsed / 1024).toFixed(0)}/${(s.cache.budgetBytes / 1024).toFixed(0)} KiB\n` +
    `pending ${s.pending}  ${timeline.paused ? 'PAUSED' : 'running'}  [space]=pause [e]=export`;
  noticeBox.textContent = engine.notices.slice(-3).map((n) => n.message).join('\n');
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
