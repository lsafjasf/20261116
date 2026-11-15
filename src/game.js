// 浏览器端：Canvas 渲染 + Web Audio + 交互（暂停/回放/失败恢复）
import {
  CONFIG, createGame, step, togglePause, applyInput,
  windAt, cloudAt, stallSpeed, stateHash, lastTransition,
} from "./sim.js";

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

let seed = Number($("seed").value) >>> 0;
let game = createGame(seed);
let mode = "live"; // live | replay
let replayState = null;
let finalHash = null;

// ---------- 输入 ----------
const keys = {};
window.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " "].includes(e.key)) e.preventDefault();
  keys[e.key.toLowerCase()] = true;
  if (e.key.toLowerCase() === "p") doPause();
  if (e.key.toLowerCase() === "r") restart();
  if (e.key.toLowerCase() === "f") flapsHeld = !flapsHeld;
  ensureAudio();
});
window.addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
let flapsHeld = false;

function currentInput() {
  return {
    pitch: (keys["arrowdown"] ? 1 : 0) + (keys["arrowup"] ? -1 : 0),
    turn: (keys["arrowright"] ? 1 : 0) + (keys["arrowleft"] ? -1 : 0),
    flaps: flapsHeld,
    dumpBallast: !!keys["b"],
  };
}

// ---------- Web Audio：噪声增益随相对风速变化 ----------
let audio = null;
function ensureAudio() {
  if (audio) { if (audio.ctx.state === "suspended") audio.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const actx = new AC();
  const len = actx.sampleRate * 2;
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = actx.createBufferSource();
  src.buffer = buf; src.loop = true;
  const filter = actx.createBiquadFilter();
  filter.type = "bandpass"; filter.frequency.value = 400; filter.Q.value = 0.8;
  const gain = actx.createGain(); gain.gain.value = 0;
  src.connect(filter).connect(gain).connect(actx.destination);
  src.start();
  const stallOsc = actx.createOscillator();
  const stallGain = actx.createGain();
  stallOsc.type = "square"; stallOsc.frequency.value = 660;
  stallGain.gain.value = 0;
  stallOsc.connect(stallGain).connect(actx.destination);
  stallOsc.start();
  audio = { ctx: actx, gain, filter, stallGain };
}

function updateAudio() {
  if (!audio) return;
  const g = game.glider;
  const flying = (game.status === "FLYING" || game.status === "STALL") && mode === "live";
  const rel = Math.max(0, Math.min(1, (g.speed - 10) / 40)); // 相对风速归一化
  const t = audio.ctx.currentTime;
  audio.gain.gain.setTargetAtTime(flying ? rel * 0.25 : 0, t, 0.1);
  audio.filter.frequency.setTargetAtTime(250 + g.speed * 18, t, 0.1);
  audio.stallGain.gain.setTargetAtTime(
    game.status === "STALL" && mode === "live" ? 0.06 : 0, t, 0.05);
}

// ---------- 渲染 ----------
const SCALE = 0.028; // px/m，视野约 32km
function toScreen(g, wx, wy) {
  return [canvas.width / 2 + (wx - g.x) * SCALE, canvas.height / 2 - (wy - g.y) * SCALE];
}

function render(viewGame, ghost) {
  const g = viewGame.glider;
  const world = viewGame.world;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 风场箭头（当前高度层）
  const w0 = windAt(world, g.x, g.y, g.alt);
  ctx.strokeStyle = "rgba(120,190,255,0.55)"; ctx.fillStyle = ctx.strokeStyle;
  ctx.font = "11px sans-serif";
  for (let gx = -6000; gx <= 6000; gx += 3000) {
    for (let gy = -6000; gy <= 6000; gy += 3000) {
      const wx = g.x + gx, wy = g.y + gy;
      const w = windAt(world, wx, wy, g.alt);
      const [sx, sy] = toScreen(g, wx, wy);
      const ex = sx + Math.cos(w.dir) * w.spd * 2.2, ey = sy - Math.sin(w.dir) * w.spd * 2.2;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, ey, 1.6, 0, 7); ctx.fill();
    }
  }

  // 云层（湿度越高越暗）
  for (const c of world.clouds) {
    const [sx, sy] = toScreen(g, c.x, c.y);
    const r = c.r * SCALE;
    const inBand = g.alt >= c.base && g.alt <= c.base + c.thickness;
    ctx.fillStyle = `rgba(200,210,225,${0.10 + c.humidity * 0.22})`;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill();
    if (inBand) { ctx.strokeStyle = "#8fd0ff"; ctx.stroke(); }
    ctx.fillStyle = "#9db1d8";
    ctx.fillText(`湿${(c.humidity * 100) | 0}% 底${c.base | 0}m`, sx - r * 0.6, sy);
  }

  // 风暴核心
  const s = world.storm;
  const [sx, sy] = toScreen(g, s.x, s.y);
  ctx.fillStyle = "rgba(220,60,60,0.35)";
  ctx.beginPath(); ctx.arc(sx, sy, s.r * SCALE, 0, 7); ctx.fill();
  ctx.strokeStyle = "#ff5b5b"; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#ff8a8a"; ctx.fillText("风暴核心", sx - 26, sy);

  // 机场
  const a = CONFIG.airport;
  const [ax, ay] = toScreen(g, a.x, a.y);
  ctx.strokeStyle = "#7dffa8"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(ax, ay, a.radius * SCALE, 0, 7); ctx.stroke();
  ctx.fillStyle = "#7dffa8"; ctx.fillText("机场", ax - 12, ay - 8); ctx.lineWidth = 1;

  // 轨迹
  ctx.strokeStyle = ghost ? "#c58fff" : "#ffd97f";
  ctx.beginPath();
  viewGame.trail.forEach(([tx, ty], i) => {
    const [px, py] = toScreen(g, tx, ty);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.stroke();

  // 滑翔器
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(g.heading);
  ctx.fillStyle = ghost ? "#c58fff" : "#ffffff";
  ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-8, 6); ctx.lineTo(-4, 0); ctx.lineTo(-8, -6); ctx.closePath(); ctx.fill();
  ctx.restore();

  // 画布内 HUD
  ctx.fillStyle = "#dfe7f5"; ctx.font = "13px sans-serif";
  ctx.fillText(`风层 ${w0.layer}  风速 ${w0.spd.toFixed(1)}m/s  时间 ${game.time.toFixed(0)}s`, 12, 20);
  ctx.fillText(`距机场 ${(Math.hypot(a.x - g.x, a.y - g.y) / 1000).toFixed(1)}km  失速速度 ${stallSpeed(g).toFixed(1)}m/s`, 12, 38);
  if (ghost) { ctx.fillStyle = "#c58fff"; ctx.fillText("回放中…", 12, 56); }
}

// ---------- HUD 面板 ----------
function updatePanel() {
  const g = game.glider;
  $("r-fuel").textContent = `${g.fuel.toFixed(0)} / ${CONFIG.fuelMax}`;
  $("r-battery").textContent = `${g.battery.toFixed(1)}%${g.battery <= 0 ? "（仪表失效）" : ""}`;
  $("r-alt").textContent = `${g.alt.toFixed(0)} m`;
  $("r-speed").textContent = `${g.speed.toFixed(1)} m/s`;
  $("r-ice").textContent = `${(g.ice * 100).toFixed(0)}%`;
  $("r-ballast").textContent = `${(g.ballast * 100).toFixed(0)}%`;
  $("sm-state").textContent = mode === "replay" ? "REPLAY" : game.status;
  const lt = lastTransition(game);
  $("sm-last").textContent = `${lt.from} → ${lt.to}（t=${(lt.tick * CONFIG.dt).toFixed(0)}s：${lt.reason}）`;
  $("hash").textContent = stateHash(game);
  $("stall-warning").classList.toggle("hidden", game.status !== "STALL" || mode !== "live");
  const over = game.status === "SUCCESS" || game.status === "FAILED";
  $("overlay").classList.toggle("hidden", !over || mode === "replay");
  if (over) {
    $("overlay-title").textContent = game.status === "SUCCESS" ? "任务成功 🎉" : "任务失败";
    $("overlay-detail").textContent =
      game.status === "SUCCESS"
        ? `用时 ${game.time.toFixed(0)}s，剩余燃料 ${g.fuel.toFixed(0)}，最终哈希 ${finalHash}`
        : `原因：${game.failReason}。可点击重新开始进行失败恢复。`;
  }
}

// ---------- 控制 ----------
function doPause() {
  if (mode !== "live") return;
  togglePause(game);
  $("btn-pause").textContent = game.status === "PAUSED" ? "继续" : "暂停";
  updateAudio();
}

function restart() {
  seed = Number($("seed").value) >>> 0; // 同 seed 重开：计时器/资源/随机序列全部复位
  game = createGame(seed);
  mode = "live";
  replayState = null;
  finalHash = null;
  flapsHeld = false;
  $("btn-pause").textContent = "暂停";
  updateAudio();
}

function startReplay() {
  if (game.records.length === 0) return;
  const records = game.records.map((r) => ({ tick: r.tick, input: { ...r.input } }));
  replayState = { game: createGame(game.seed), records, ri: 0, done: false };
  mode = "replay";
  $("overlay").classList.add("hidden");
}

$("btn-pause").addEventListener("click", doPause);
$("btn-restart").addEventListener("click", restart);
$("btn-restart-overlay").addEventListener("click", restart);
$("btn-replay").addEventListener("click", startReplay);
$("seed").addEventListener("change", restart);

// ---------- 主循环（固定步长） ----------
let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;
  while (acc >= CONFIG.dt) {
    acc -= CONFIG.dt;
    if (mode === "live") {
      step(game, currentInput());
      if ((game.status === "SUCCESS" || game.status === "FAILED") && !finalHash) {
        finalHash = stateHash(game);
      }
    } else if (replayState && !replayState.done) {
      const rp = replayState;
      while (rp.ri < rp.records.length && rp.records[rp.ri].tick === rp.game.tick) {
        applyInput(rp.game, rp.records[rp.ri].input);
        rp.ri++;
      }
      step(rp.game);
      if (rp.game.status === "SUCCESS" || rp.game.status === "FAILED" || rp.game.tick >= game.tick) {
        rp.done = true;
        const h1 = stateHash(rp.game), h2 = finalHash || stateHash(game);
        $("objective").textContent =
          h1 === h2 ? `回放校验一致 ✓（hash ${h1}）` : `回放不一致 ✗ ${h1} ≠ ${h2}`;
      }
    }
  }
  render(mode === "replay" && replayState ? replayState.game : game, mode === "replay");
  updatePanel();
  updateAudio();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
