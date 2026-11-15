// 浏览器端：Canvas 库房剖面 + Web Audio + 仿真时钟控制（暂停/单步/恢复/回放）
/* global ColdSim, ColdScenarios */
(function () {
  "use strict";

  const cv = document.getElementById("cv");
  const ctx = cv.getContext("2d");
  const logEl = document.getElementById("log");
  const statusEl = document.getElementById("status");

  const SPEEDS = [1, 10, 60, 240];
  let speedIdx = 1;
  let paused = false;
  let sim = null;
  let renderedLogCount = 0;
  let acc = 0;
  let lastTs = 0;

  function newGame() {
    sim = ColdSim.createSim(ColdScenarios.normal.options);
    renderedLogCount = 0;
    logEl.innerHTML = "";
    paused = false;
    document.getElementById("btnPause").textContent = "暂停";
    refreshButtons();
  }

  // ---- 操作：全部经统一时钟记录 ----
  function act(a) {
    ColdSim.applyAction(sim, a);
    refreshButtons();
  }

  const zoneBtns = document.getElementById("zoneBtns");
  for (let i = 0; i < 3; i++) {
    const b1 = document.createElement("button");
    b1.textContent = "除霜" + (i + 1);
    b1.id = "defrost" + i;
    b1.onclick = (function (z) {
      return function () {
        act({ type: sim.zones[z].defrosting ? "defrostStop" : "defrostStart", zone: z });
      };
    })(i);
    const b2 = document.createElement("button");
    b2.textContent = "风机" + (i + 1);
    b2.id = "fan" + i;
    b2.onclick = (function (z) {
      return function () { act({ type: "fanToggle", zone: z }); };
    })(i);
    zoneBtns.appendChild(b1);
    zoneBtns.appendChild(b2);
  }

  document.getElementById("btnBackup").onclick = function () { act({ type: "backupToggle" }); };
  document.getElementById("btnDoor").onclick = function () { act({ type: "doorToggle" }); };
  document.getElementById("btnPause").onclick = function () {
    paused = !paused;
    this.textContent = paused ? "恢复" : "暂停";
  };
  document.getElementById("btnStep").onclick = function () {
    if (!sim.over) { ColdSim.step(sim); syncLog(); }
  };
  document.getElementById("btnSpeed").onclick = function () {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    this.textContent = "速度 " + SPEEDS[speedIdx] + "x";
  };
  document.getElementById("btnReset").onclick = newGame;
  document.getElementById("btnReplay").onclick = function () {
    // 失败回放：用记录的操作序列重建到失败/报警时刻并暂停
    const incident = sim.log.find(function (e) {
      return e.kind === "fail" || e.kind === "fault" || e.kind === "alarm";
    });
    const until = incident ? incident.t : sim.clock;
    sim = ColdSim.replay(ColdScenarios.normal.options, sim.actions, until);
    renderedLogCount = 0;
    logEl.innerHTML = "";
    paused = true;
    document.getElementById("btnPause").textContent = "恢复";
    syncLog();
  };

  function refreshButtons() {
    for (let i = 0; i < 3; i++) {
      document.getElementById("defrost" + i).className = sim.zones[i].defrosting ? "active" : "";
      document.getElementById("fan" + i).className = sim.zones[i].fanOn ? "active" : "";
    }
    document.getElementById("btnBackup").className = sim.backupOn ? "active" : "";
    document.getElementById("btnDoor").className = sim.doorOpen ? "warn" : "";
  }

  function syncLog() {
    for (; renderedLogCount < sim.log.length; renderedLogCount++) {
      const e = sim.log[renderedLogCount];
      const d = document.createElement("div");
      d.className = "k-" + e.kind;
      const mm = String(Math.floor(e.t / 60)).padStart(2, "0");
      const ss = String(e.t % 60).padStart(2, "0");
      d.textContent = "[" + mm + ":" + ss + "] " + e.msg;
      logEl.appendChild(d);
    }
    logEl.scrollTop = logEl.scrollHeight;
  }

  function fmtClock(t) {
    return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
  }

  function updateStatus() {
    const m = ColdSim.marginInfo(sim);
    statusEl.innerHTML =
      "时钟 " + fmtClock(sim.clock) + " / 60:00" +
      (paused ? "（已暂停）" : "") + (sim.over ? "（已结束）" : "") + "<br>" +
      "温度余量: 上限-" + m.toUpper.toFixed(2) + "°C / 下限+" + m.toLower.toFixed(2) + "°C<br>" +
      "主压缩机: " + (sim.compressorFailed ? "故障" : sim.compressorOn ? "运行" : "停机") +
      " | 备用机组: " + (sim.backupOn ? "投入" : "退出") +
      " | 库门: " + (sim.doorOpen ? "开" : "关") +
      (sim.over ? "<br><b>" + (sim.success ? "成功！" : "失败: " + sim.failReason) + "</b>" : "");
  }

  // ---- 主循环：仿真时钟按速度倍率推进 ----
  function frame(ts) {
    const dtReal = Math.min(0.1, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    if (!paused && !sim.over) {
      acc += dtReal * SPEEDS[speedIdx];
      while (acc >= 1 && !sim.over) {
        ColdSim.step(sim);
        acc -= 1;
      }
      refreshButtons();
    }
    syncLog();
    updateStatus();
    render();
    updateAudio();
    requestAnimationFrame(frame);
  }

  // ---- Canvas：库房剖面 ----
  function tempColor(t) {
    // 2°C 以下深蓝 -> 5°C 绿 -> 8°C 以上红
    const c = Math.max(-2, Math.min(12, t));
    const hue = 220 - ((c + 2) / 14) * 220; // 220(蓝) -> 0(红)
    return "hsl(" + hue + ",70%," + (t < 2 || t > 8 ? 45 : 32) + "%)";
  }

  function render() {
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const roomX = 40, roomY = 90, roomW = W - 120, roomH = 330;
    const zoneW = roomW / 3;

    // 库房外壳
    ctx.fillStyle = "#0a1220";
    ctx.fillRect(roomX - 14, roomY - 14, roomW + 28, roomH + 28);
    ctx.strokeStyle = "#3a6a9a";
    ctx.lineWidth = 3;
    ctx.strokeRect(roomX - 14, roomY - 14, roomW + 28, roomH + 28);
    ctx.fillStyle = "#7fd4ff";
    ctx.font = "13px sans-serif";
    ctx.fillText("冷库剖面（保温库体）", roomX - 10, roomY - 24);

    sim.zones.forEach(function (z, i) {
      const x = roomX + i * zoneW;
      // 货区底色按温度
      ctx.fillStyle = tempColor(z.temp);
      ctx.fillRect(x, roomY, zoneW, roomH);
      ctx.strokeStyle = "#22405e";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, roomY, zoneW, roomH);

      // 货物货架
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      for (let s = 0; s < 3; s++) ctx.fillRect(x + 22, roomY + 150 + s * 52, zoneW - 44, 34);
      if (z.humidCargo) {
        ctx.fillStyle = "rgba(120,220,255,0.25)";
        ctx.fillRect(x + 22, roomY + 150, zoneW - 44, 34);
        ctx.fillStyle = "#bfeaff";
        ctx.font = "11px sans-serif";
        ctx.fillText("高湿货物", x + 28, roomY + 170);
      }

      // 蒸发器盘管（顶部）
      const coilY = roomY + 34;
      ctx.strokeStyle = z.defrosting ? "#ff9a5a" : "#8ac6ff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let cx = x + 26; cx < x + zoneW - 26; cx += 18) {
        ctx.moveTo(cx, coilY - 10);
        ctx.lineTo(cx + 9, coilY + 10);
      }
      ctx.stroke();

      // 霜层：白色覆盖厚度随 frost 增长
      const fh = (z.frost / ColdSim.FROST_MAX) * 26;
      ctx.fillStyle = "rgba(240,250,255,0.92)";
      ctx.fillRect(x + 22, coilY - 13, (zoneW - 44) * Math.min(1, z.frost / ColdSim.FROST_MAX), 6 + fh * 0.4);
      ctx.fillRect(x + 22, coilY + 7, (zoneW - 44) * Math.min(1, z.frost / ColdSim.FROST_MAX), 6 + fh * 0.4);

      // 风机（旋转叶片）
      const fanX = x + zoneW / 2, fanY = roomY + 86;
      ctx.strokeStyle = z.fanOn && !z.defrosting ? "#aef" : "#557";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(fanX, fanY, 16, 0, Math.PI * 2);
      ctx.stroke();
      if (z.fanOn && !z.defrosting) {
        const ang = (sim.clock * 0.3 + i) % (Math.PI * 2);
        ctx.beginPath();
        for (let b = 0; b < 3; b++) {
          ctx.moveTo(fanX, fanY);
          ctx.lineTo(fanX + 14 * Math.cos(ang + (b * 2 * Math.PI) / 3), fanY + 14 * Math.sin(ang + (b * 2 * Math.PI) / 3));
        }
        ctx.stroke();
        // 风道气流箭头
        ctx.strokeStyle = "rgba(160,220,255,0.5)";
        const off = (sim.clock * 2) % 30;
        for (let ay = fanY + 24 + off; ay < roomY + roomH - 20; ay += 30) {
          ctx.beginPath();
          ctx.moveTo(fanX, ay);
          ctx.lineTo(fanX, ay + 12);
          ctx.moveTo(fanX - 4, ay + 8);
          ctx.lineTo(fanX, ay + 12);
          ctx.lineTo(fanX + 4, ay + 8);
          ctx.stroke();
        }
      } else {
        ctx.fillStyle = "#89a";
        ctx.font = "10px sans-serif";
        ctx.fillText(z.defrosting ? "除霜中" : "风机停", fanX - 18, fanY + 4);
      }

      // 除霜加热丝
      if (z.defrosting) {
        ctx.strokeStyle = "rgba(255,120,60," + (0.5 + 0.5 * Math.sin(sim.clock * 0.5)) + ")";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 22, coilY + 22);
        ctx.lineTo(x + zoneW - 22, coilY + 22);
        ctx.stroke();
      }

      // 标签
      ctx.fillStyle = "#eaf6ff";
      ctx.font = "bold 15px sans-serif";
      ctx.fillText("货区" + (i + 1) + "  " + z.temp.toFixed(1) + "°C", x + 14, roomY + roomH - 40);
      ctx.font = "11px sans-serif";
      ctx.fillStyle = z.frost > 3.5 ? "#ffb0a0" : "#cfe8ff";
      ctx.fillText("霜层 " + z.frost.toFixed(1) + "mm" + (z.defrostDone ? "（已除霜）" : ""), x + 14, roomY + roomH - 20);
      if (z.temp < 2 || z.temp > 8) {
        ctx.fillStyle = "rgba(255,60,40," + (0.4 + 0.4 * Math.sin(sim.clock * 0.6)) + ")";
        ctx.font = "bold 13px sans-serif";
        ctx.fillText("⚠ 温度超限", x + 14, roomY + roomH - 60);
      }
    });

    // 库门（右侧）
    const doorX = roomX + roomW + 14;
    ctx.fillStyle = sim.doorOpen ? "#1a2c44" : "#2a4a6a";
    ctx.fillRect(doorX, roomY + 100, 26, 160);
    ctx.strokeStyle = "#7fd4ff";
    ctx.strokeRect(doorX, roomY + 100, 26, 160);
    if (sim.doorOpen) {
      ctx.fillStyle = "rgba(255,180,80,0.6)";
      const off = (sim.clock * 3) % 26;
      for (let hx = doorX - 26 - off; hx > roomX + roomW - 120; hx -= 26) {
        ctx.beginPath();
        ctx.moveTo(hx + 14, roomY + 176);
        ctx.lineTo(hx, roomY + 176);
        ctx.lineTo(hx + 6, roomY + 170);
        ctx.moveTo(hx, roomY + 176);
        ctx.lineTo(hx + 6, roomY + 182);
        ctx.fill();
      }
      ctx.fillStyle = "#ffcf8a";
      ctx.font = "11px sans-serif";
      ctx.fillText("热空气涌入", doorX - 80, roomY + 92);
    }

    // 顶部设备条：压缩机 / 备用机组
    drawUnit(roomX, 30, "主压缩机", sim.compressorFailed ? "#ff6a5a" : sim.compressorOn ? "#5aff8a" : "#8a9");
    drawUnit(roomX + 180, 30, "备用机组", sim.backupOn ? "#5aff8a" : "#8a9");
    // 温度安全带
    ctx.fillStyle = "#9fb";
    ctx.font = "12px sans-serif";
    ctx.fillText("药品安全温区 2~8°C（超限持续 150s 判失败）", roomX + 380, 40);
  }

  function drawUnit(x, y, label, color) {
    ctx.fillStyle = "#16273e";
    ctx.fillRect(x, y - 16, 150, 30);
    ctx.strokeStyle = "#3a6a9a";
    ctx.strokeRect(x, y - 16, 150, 30);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 16, y - 1, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#cfe3f5";
    ctx.font = "12px sans-serif";
    ctx.fillText(label, x + 30, y + 3);
  }

  // ---- Web Audio：随压缩机工况变化 ----
  let audio = null;
  function initAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctxA = new AC();
    const master = ctxA.createGain();
    master.gain.value = 0.15;
    master.connect(ctxA.destination);

    // 主压缩机：低频轰鸣，转速感随负荷
    const compOsc = ctxA.createOscillator();
    compOsc.type = "sawtooth";
    compOsc.frequency.value = 55;
    const compGain = ctxA.createGain();
    compGain.gain.value = 0;
    const compFilter = ctxA.createBiquadFilter();
    compFilter.type = "lowpass";
    compFilter.frequency.value = 240;
    compOsc.connect(compFilter).connect(compGain).connect(master);
    compOsc.start();

    // 备用机组：高一档的嗡鸣
    const backOsc = ctxA.createOscillator();
    backOsc.type = "triangle";
    backOsc.frequency.value = 82;
    const backGain = ctxA.createGain();
    backGain.gain.value = 0;
    backOsc.connect(backGain).connect(master);
    backOsc.start();

    // 风机/除霜：滤波噪声
    const noiseBuf = ctxA.createBuffer(1, ctxA.sampleRate, ctxA.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctxA.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const noiseFilter = ctxA.createBiquadFilter();
    noiseFilter.type = "bandpass";
    noiseFilter.frequency.value = 900;
    const noiseGain = ctxA.createGain();
    noiseGain.gain.value = 0;
    noise.connect(noiseFilter).connect(noiseGain).connect(master);
    noise.start();

    // 报警：间歇蜂鸣
    const alarmOsc = ctxA.createOscillator();
    alarmOsc.type = "square";
    alarmOsc.frequency.value = 880;
    const alarmGain = ctxA.createGain();
    alarmGain.gain.value = 0;
    alarmOsc.connect(alarmGain).connect(master);
    alarmOsc.start();

    audio = { ctx: ctxA, compOsc: compOsc, compGain: compGain, backGain: backGain, noiseGain: noiseGain, alarmGain: alarmGain };
    document.getElementById("btnAudio").textContent = "声音已开";
  }

  document.getElementById("btnAudio").onclick = function () {
    if (!audio) initAudio();
    else if (audio.ctx.state === "suspended") audio.ctx.resume();
  };

  function updateAudio() {
    if (!audio) return;
    const t = audio.ctx.currentTime;
    const anyAlarm = sim.zones.some(function (z) { return z.temp < 2 || z.temp > 8; });
    const compOn = sim.compressorOn && !sim.compressorFailed;
    // 负荷越大（库温越高）压缩机音调越高
    const hottest = Math.max.apply(null, sim.zones.map(function (z) { return z.temp; }));
    audio.compGain.gain.setTargetAtTime(compOn ? 0.5 : 0, t, 0.1);
    audio.compOsc.frequency.setTargetAtTime(50 + hottest * 2.5, t, 0.2);
    audio.backGain.gain.setTargetAtTime(sim.backupOn ? 0.3 : 0, t, 0.1);
    const fansOn = sim.zones.filter(function (z) { return z.fanOn && !z.defrosting; }).length;
    const defrosting = sim.zones.some(function (z) { return z.defrosting; });
    audio.noiseGain.gain.setTargetAtTime(defrosting ? 0.25 : fansOn * 0.05, t, 0.15);
    const beep = anyAlarm && Math.floor(sim.clock * 2) % 2 === 0;
    audio.alarmGain.gain.setTargetAtTime(beep ? 0.12 : 0, t, 0.03);
  }

  newGame();
  requestAnimationFrame(frame);
})();
