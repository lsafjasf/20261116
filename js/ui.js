// UI 主控：仿真循环（暂停/单步/恢复）、Canvas 渲染、操作记录、失败回放
import { Sim, SIM_DURATION, LIMITS, SCENARIOS, fmtT } from './sim.js';
import { FlowAudio } from './audio.js';

const $ = s => document.querySelector(s);
const cv = $('#cv');
const ctx = cv.getContext('2d');
const audio = new FlowAudio();

const SPEEDS = [0, 10, 30, 60, 120, 240, 480]; // 仿真秒/真实秒

const game = {
  sim: null,
  paused: false,
  seed: (Math.random() * 1e9) | 0,
  lastFailRecord: JSON.parse(localStorage.getItem('damFailRecord') || 'null'),
  renderedLogLen: 0,
};

function newSim(scenario, seed) {
  game.sim = new Sim({ scenario, seed: seed ?? ((Math.random() * 1e9) | 0) });
  game.paused = false;
  game.renderedLogLen = 0;
  $('#log').innerHTML = '';
  syncControlsFromSim();
}

// ---- 仿真循环：真实时间驱动，内部按仿真时钟步进 ----
let lastTs = 0, acc = 0;
function loop(ts) {
  const dtReal = Math.min(0.1, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  const sim = game.sim;
  if (!game.paused && sim.status === 'running') {
    acc += dtReal * SPEEDS[+$('#speed').value];
    while (acc >= 1 && sim.status === 'running') { sim.step(); acc -= 1; }
  }
  render();
  updatePanel();
  flushLog();
  audio.update(sim.qOut);
  audio.alarm(sim.qOut > LIMITS.downHard || sim.level > LIMITS.levelWarn);
  requestAnimationFrame(loop);
}

// ---- 控制按钮 ----
$('#btnPause').onclick = () => { game.paused = true; };
$('#btnResume').onclick = () => { game.paused = false; };
$('#btnStep').onclick = () => { // 单步：暂停下推进一个仿真秒
  game.paused = true;
  if (game.sim.status === 'running') game.sim.step();
};
$('#btnRestart').onclick = () => newSim($('#scenario').value);
$('#audioOn').onchange = e => audio.setEnabled(e.target.checked);

$('#btnReplayFail').onclick = () => {
  const rec = game.lastFailRecord;
  if (!rec) return;
  // 失败回放：同种子同场景重放操作日志，快进到失败前 60s 后暂停，便于复盘
  const failT = rec.log.find(e => e.type === 'failure')?.t ?? 0;
  game.sim = Sim.replay(rec.log, { until: Math.max(0, failT - 60) });
  game.paused = false;
  game.renderedLogLen = 0;
  $('#log').innerHTML = '';
  syncControlsFromSim();
};

// ---- 闸门 / 泄洪道操作 ----
function bindGates() {
  document.querySelectorAll('.gate').forEach(el => {
    const key = el.dataset.gate;
    const slider = el.querySelector('input[type=range]');
    slider.addEventListener('change', () => {
      const v = +slider.value / 100;
      if (key === 'spill') game.sim.setSpillTarget(v);
      else game.sim.setGateTarget(+key, v);
    });
    const repair = el.querySelector('.repair');
    if (repair) repair.onclick = () => game.sim.repairGate(+key);
  });
}

function syncControlsFromSim() {
  const s = game.sim.snapshot();
  document.querySelectorAll('.gate').forEach(el => {
    const key = el.dataset.gate;
    const slider = el.querySelector('input[type=range]');
    const label = el.querySelector('.gv');
    const g = key === 'spill' ? s.spill : s.gates[+key];
    slider.value = Math.round(g.target * 100);
    label.textContent = `${Math.round(g.target * 100)}%`;
    el.classList.toggle('stuck', !!g.stuck);
    const repair = el.querySelector('.repair');
    if (repair) repair.disabled = !g.stuck;
  });
}

// ---- 面板与状态 ----
function updatePanel() {
  const s = game.sim.snapshot();
  $('#clock').textContent = `${s.clock} / 06:00:00`;
  const badge = $('#statusBadge');
  const map = { running: game.paused ? ['已暂停', 'paused'] : ['运行中', 'running'],
                success: ['成功', 'success'], failed: ['失败', 'failed'] };
  const [txt, cls] = map[s.status];
  badge.textContent = txt;
  badge.className = `badge ${cls}`;

  $('#mLevel').textContent = s.level.toFixed(2);
  $('#mQin').textContent = s.qIn.toFixed(0);
  $('#mQout').textContent = s.qOut.toFixed(0);
  $('#mScour').textContent = s.scour.toFixed(1);
  const lm = $('#mLevelMargin'), fm = $('#mFlowMargin');
  lm.textContent = `余量 ${s.margins.level.toFixed(2)} m`;
  lm.className = `margin ${s.margins.level > 3 ? 'ok' : 'bad'}`;
  fm.textContent = `余量 ${s.margins.flow.toFixed(0)} m³/s`;
  fm.className = `margin ${s.margins.flow > 0 ? 'ok' : 'bad'}`;
  $('#mForecast').textContent = s.forecast
    ? `降雨预报：${fmtT(s.forecast.start)}~${fmtT(s.forecast.end)} 区间 ${s.forecast.lo.toFixed(0)}~${s.forecast.hi.toFixed(0)} m³/s（概率性）`
    : '降雨预报：未来 30 分钟无显著降雨';

  // 实时同步开度显示（目标值可能被故障冻结）
  document.querySelectorAll('.gate').forEach(el => {
    const key = el.dataset.gate;
    const g = key === 'spill' ? s.spill : s.gates[+key];
    el.querySelector('.gv').textContent =
      `${Math.round(g.target * 100)}% (实际 ${Math.round(g.open * 100)}%)` + (g.stuck ? ' 卡涩!' : '');
    el.classList.toggle('stuck', !!g.stuck);
    const repair = el.querySelector('.repair');
    if (repair) repair.disabled = !g.stuck || g.repairLeft > 0;
    if (repair && g.stuck && g.repairLeft > 0) repair.textContent = `修复中 ${g.repairLeft}s`;
    else if (repair) repair.textContent = '修复';
  });

  // 失败时保存记录供回放
  if (s.status === 'failed' && !game._failSaved) {
    game._failSaved = true;
    game.lastFailRecord = { seed: game.sim.seed, scenario: game.sim.scenarioName, log: game.sim.log };
    localStorage.setItem('damFailRecord', JSON.stringify(game.lastFailRecord));
    $('#btnReplayFail').disabled = false;
  }
  if (s.status === 'running') game._failSaved = false;
  $('#btnReplayFail').disabled = !game.lastFailRecord;
}

// ---- 操作与事件日志（增量渲染） ----
function flushLog() {
  const log = game.sim.log;
  if (log.length === game.renderedLogLen) return;
  const box = $('#log');
  for (let i = game.renderedLogLen; i < log.length; i++) {
    const e = log[i];
    const div = document.createElement('div');
    div.className = e.type;
    let text = `[${e.clock}] `;
    if (e.type === 'op') text += `操作 ${e.device} ${e.action} -> ${e.value}`;
    else if (e.type === 'fault') text += `故障 ${e.device}：${e.detail}｜余量 水位${e.margins.level}m 流量${e.margins.flow}｜${e.response}`;
    else if (e.type === 'recover') text += `恢复 ${e.device}：${e.detail}｜余量 水位${e.margins.level}m 流量${e.margins.flow}`;
    else if (e.type === 'failure') text += `失败：${e.detail}｜余量 水位${e.margins.level}m 流量${e.margins.flow}`;
    else if (e.type === 'success') text += e.detail;
    else text += `${e.type} ${e.detail ?? ''}`;
    div.textContent = text;
    box.appendChild(div);
  }
  game.renderedLogLen = log.length;
  box.scrollTop = box.scrollHeight;
}

// ---- Canvas 渲染：坝体剖面 + 闸门 + 水位 + 下游街区 ----
const Y = L => 440 - (L - 14) * 13; // 水位(m) -> 画布 y
const DAM_X = 400, DAM_W = 110, BED_Y = 440;

function render() {
  const s = game.sim.snapshot();
  const w = cv.width, h = cv.height;
  // 天空与山体
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#0d1a2b'); sky.addColorStop(1, '#16283c');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1d2f42';
  ctx.beginPath(); ctx.moveTo(0, BED_Y); ctx.lineTo(0, 300);
  ctx.lineTo(160, 220); ctx.lineTo(320, 330); ctx.lineTo(DAM_X, BED_Y); ctx.closePath(); ctx.fill();
  ctx.fillRect(0, BED_Y, w, h - BED_Y);

  // 库区水体
  const wl = Y(Math.max(14, Math.min(38, s.level)));
  ctx.fillStyle = 'rgba(46,120,190,0.85)';
  ctx.fillRect(0, wl, DAM_X + 8, BED_Y - wl);
  ctx.strokeStyle = '#7fd4ff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, wl); ctx.lineTo(DAM_X + 8, wl); ctx.stroke();

  // 水位限值线
  for (const [L, c, name] of [[LIMITS.levelMax, '#ff6b5e', '坝体安全上限'],
                              [LIMITS.levelWarn, '#ffd97f', '预警水位']]) {
    ctx.strokeStyle = c; ctx.setLineDash([6, 5]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, Y(L)); ctx.lineTo(DAM_X, Y(L)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c; ctx.font = '11px sans-serif';
    ctx.fillText(`${name} ${L}m`, 8, Y(L) - 4);
  }

  // 坝体剖面（梯形）
  ctx.fillStyle = '#5a6673';
  ctx.beginPath();
  ctx.moveTo(DAM_X, BED_Y); ctx.lineTo(DAM_X + 18, Y(37)); ctx.lineTo(DAM_X + DAM_W - 30, Y(37));
  ctx.lineTo(DAM_X + DAM_W, BED_Y); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#6e7b89';
  ctx.fillRect(DAM_X + 14, Y(37), DAM_W - 40, 6); // 坝顶

  // 闸门：坝体下游面三个孔口 + 可升降门叶
  const gateTop = Y(26), gateBot = Y(18);
  for (let i = 0; i < 3; i++) {
    const gx = DAM_X + 24 + i * 26;
    ctx.fillStyle = '#101c28';
    ctx.fillRect(gx, gateTop, 18, gateBot - gateTop); // 孔口
    const g = s.gates[i];
    const leafH = (gateBot - gateTop) * (1 - g.open);
    ctx.fillStyle = g.stuck ? '#a03a2e' : '#c8a24a';
    ctx.fillRect(gx, gateTop, 18, leafH); // 门叶（开度越大越短）
    if (g.open > 0.02) { // 出流射流
      ctx.strokeStyle = 'rgba(127,212,255,0.8)';
      ctx.lineWidth = 3 + 4 * g.open;
      ctx.beginPath();
      ctx.moveTo(gx + 9, gateBot - 4);
      ctx.quadraticCurveTo(gx + 40, gateBot + 6, gx + 70, BED_Y + 24);
      ctx.stroke();
    }
    ctx.fillStyle = '#dfe8f0'; ctx.font = '10px sans-serif';
    ctx.fillText(`${i + 1}#`, gx + 3, gateTop - 4);
  }

  // 泄洪道：坝右岸明渠
  const spX = DAM_X + DAM_W + 30;
  ctx.fillStyle = '#4a5560';
  ctx.beginPath();
  ctx.moveTo(spX, Y(20)); ctx.lineTo(spX + 90, BED_Y + 10); ctx.lineTo(spX + 90, BED_Y + 26);
  ctx.lineTo(spX, Y(20) + 16); ctx.closePath(); ctx.fill();
  if (s.spill.open > 0.02) {
    ctx.strokeStyle = 'rgba(160,220,255,0.85)';
    ctx.lineWidth = 2 + 10 * s.spill.open;
    ctx.beginPath();
    ctx.moveTo(spX + 4, Y(20) + 8); ctx.lineTo(spX + 88, BED_Y + 18); ctx.stroke();
  }
  ctx.fillStyle = '#9fb8cc'; ctx.font = '11px sans-serif';
  ctx.fillText(`泄洪道 ${Math.round(s.spill.open * 100)}%`, spX, Y(20) - 6);

  // 下游河道：水深随出流
  const depth = Math.min(60, s.qOut / 4500 * 60);
  ctx.fillStyle = s.qOut > LIMITS.downHard ? 'rgba(200,90,60,0.85)' : 'rgba(46,120,190,0.8)';
  ctx.fillRect(DAM_X + DAM_W, BED_Y + 30 - depth, w - DAM_X - DAM_W, depth + 20);

  // 下游城镇街区
  const townX = 720;
  for (let i = 0; i < 5; i++) {
    const bw = 34, bh = 40 + (i % 3) * 18, bx = townX + i * 46, by = BED_Y + 30 - bh;
    const flooded = s.qOut > LIMITS.downSafe && depth > 34;
    ctx.fillStyle = flooded ? '#7a4a3a' : '#3a5a7a';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#ffe9a0';
    for (let wy = by + 6; wy < by + bh - 6; wy += 12)
      for (let wx = bx + 5; wx < bx + bw - 6; wx += 11)
        ctx.fillRect(wx, wy, 5, 6);
  }
  ctx.fillStyle = '#9fb8cc'; ctx.font = '12px sans-serif';
  ctx.fillText('下游城镇', townX + 40, BED_Y - 60);
  ctx.fillText(`下游安全流量 ${LIMITS.downSafe} m³/s`, w - 200, 24);

  // 状态水印
  if (s.status !== 'running') {
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = s.status === 'success' ? '#7fe6a2' : '#ff9f7f';
    ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(s.status === 'success' ? '调度成功' : '调度失败', w / 2, h / 2 - 10);
    ctx.font = '15px sans-serif';
    ctx.fillText(s.failReason || '六小时模拟结束，坝体与下游均达标', w / 2, h / 2 + 22);
    ctx.textAlign = 'left';
  } else if (game.paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffd97f'; ctx.font = 'bold 26px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('已暂停', w / 2, 60); ctx.textAlign = 'left';
  }
}

// ---- 启动 ----
bindGates();
newSim($('#scenario').value);
$('#btnReplayFail').disabled = !game.lastFailRecord;
requestAnimationFrame(loop);
