/* 前端控制器：仿真时钟、暂停/单步/恢复/失败回放、键盘、指标与音频联动 */
(function () {
  'use strict';

  const sim = new CableSim.Simulation();
  const renderer = new Renderer(document.getElementById('scene'));
  const audio = new SimAudio();
  const $ = (id) => document.getElementById(id);

  const state = {
    paused: false, speed: 1, accumulator: 0, lastTs: 0,
    scenario: 'normal', manual: { throttle: 0, winch: 0 }, driver: null,
    lastEventCount: 0, replayMode: false
  };

  function loadScenario(name) {
    sim.reset();
    state.scenario = name;
    state.paused = false;
    state.replayMode = false;
    state.lastEventCount = 0;
    state.driver = name === 'manual' ? null : Autopilot.createDriver(name);
    $('log').innerHTML = '';
    refreshLog();
    render();
  }

  function render() {
    renderer.draw(sim);
    renderMetrics();
    const badge = $('modeBadge');
    badge.textContent = sim.mode;
    badge.className = `badge ${sim.mode}`;
    $('clockInfo').textContent = `t=${sim.time.toFixed(1)}s tick=${sim.tick}`;
  }

  function bar(label, ratio, valueText, dangerAt = 0.9, warnAt = 0.7) {
    const pct = Math.max(0, Math.min(1, ratio)) * 100;
    const color = ratio >= dangerAt ? 'var(--bad)' : ratio >= warnAt ? 'var(--warn)' : 'var(--ok)';
    return `<div class="k">${label}</div><div>${valueText}</div>
      <div class="bar" style="grid-column:1/3"><i style="width:${pct}%;background:${color}"></i></div>`;
  }

  function renderMetrics() {
    const c = sim.cfg;
    const m = sim.margins();
    const html = [
      '<h2 style="margin-top:0">设备状态</h2><div class="metric">',
      bar('脐带张力', sim.umbilical.tension / c.TENSION_BREAK,
        `${(sim.umbilical.tension / 1000).toFixed(1)} / ${c.TENSION_BREAK / 1000} kN`),
      bar('电力负载', sim.power.load / c.POWER_LIMIT,
        `${sim.power.load.toFixed(1)} / ${c.POWER_LIMIT} kW`),
      bar('船位漂移', Math.abs(sim.ship.x) / c.DRIFT_LIMIT,
        `${Math.abs(sim.ship.x).toFixed(2)} / ${c.DRIFT_LIMIT} m`),
      '</div>',
      '<h2>安全余量</h2><div class="metric">',
      `<div class="k">张力余量</div><div>${m.tension_kN} kN</div>`,
      `<div class="k">漂移余量</div><div>${m.drift_m} m</div>`,
      `<div class="k">电力余量</div><div>${m.power_kW} kW</div>`,
      `<div class="k">过载计时</div><div>${sim.power.overloadT.toFixed(1)} / ${c.OVERLOAD_LIMIT_T} s</div>`,
      '</div>',
      '<h2>工具 / 推进器</h2><div class="metric">',
      `<div class="k">当前工具</div><div>${sim.tool.name}${sim.power.pumpOn ? ' + 辅助泵' : ''}</div>`,
      `<div class="k">作业状态</div><div>${sim.tool.progressText}</div>`,
      `<div class="k">左舷推进器</div><div>${sim.thrusters.port.healthy ? '正常' : '故障 30%'}</div>`,
      `<div class="k">右舷推进器</div><div>${sim.thrusters.starboard.healthy ? '正常' : '故障'}</div>`,
      `<div class="k">脐带状态</div><div>${sim.umbilical.broken ? '断裂' : '完好'}</div>`,
      `<div class="k">工具深度</div><div>${sim.umbilical.z.toFixed(1)} m</div>`,
      `<div class="k">横向偏移</div><div>${sim.umbilical.offset.toFixed(2)} m</div>`,
      '</div>'
    ].join('');
    $('metrics').innerHTML = html;
  }

  function refreshLog() {
    const log = $('log');
    while (state.lastEventCount < sim.events.length) {
      const ev = sim.events[state.lastEventCount++];
      const div = document.createElement('div');
      div.className = `ev ${ev.kind}`;
      const marginText = ev.kind === 'abort' || ev.kind === 'fault'
        ? ` 余量=${JSON.stringify(ev.margins)}` : '';
      div.textContent = `[${ev.time.toFixed(1).padStart(7)}s] ${ev.kind} · ${ev.message}${marginText}`;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      if (ev.kind === 'abort') audio.alarm('abort');
      else if (ev.kind === 'fault') audio.alarm('fault');
    }
  }

  function frame(ts) {
    if (!state.lastTs) state.lastTs = ts;
    const dtWall = Math.min(0.1, (ts - state.lastTs) / 1000);
    state.lastTs = ts;

    if (!state.paused && !state.replayMode) {
      state.accumulator += dtWall * state.speed;
      const stepWall = CableSim.constants.DT;
      let guard = 0;
      while (state.accumulator >= stepWall && guard < 200) {
        if (sim.mode === 'complete') break;
        if (state.scenario === 'manual') {
          sim.step(state.scenario === 'manual' ? { ...state.manual } : null);
        } else if (state.driver) {
          sim.step(state.driver.next(sim.tick));
        } else {
          sim.step(null);
        }
        state.accumulator -= stepWall;
        guard++;
      }
      refreshLog();
    }
    audio.sounding = !state.paused && sim.mode !== 'aborted';
    audio.update(sim);
    render();
    requestAnimationFrame(frame);
  }

  function replayFailure() {
    const record = sim.exportRecord();
    const firstAbort = record.events.find((e) => e.kind === 'abort');
    if (!firstAbort) {
      alert('当前场景没有失败事件，无可回放内容');
      return;
    }
    sim.replayRecord(record, firstAbort.tick + 1);
    state.replayMode = true;
    state.paused = true;
    state.lastEventCount = sim.events.length;
    $('log').innerHTML = '';
    sim.events.forEach((ev) => {
      const div = document.createElement('div');
      div.className = `ev ${ev.kind}`;
      div.textContent = `[${ev.time.toFixed(1).padStart(7)}s] ${ev.kind} · ${ev.message}`;
      $('log').appendChild(div);
    });
    audio.alarm('abort');
    render();
  }

  function bind() {
    $('btnLoad').onclick = () => loadScenario($('scenario').value);
    $('btnPause').onclick = () => { state.paused = true; audio.setSounding(false); };
    $('btnStep').onclick = () => {
      state.paused = true;
      if (state.scenario === 'manual') sim.step({ ...state.manual });
      else if (state.driver) sim.step(state.driver.next(sim.tick));
      else sim.step(null);
      refreshLog(); render();
    };
    $('btnResume').onclick = () => { state.paused = false; state.replayMode = false; audio.ensure(); };
    $('btnReplay').onclick = replayFailure;
    $('btnRecover').onclick = () => {
      if (sim.mode === 'aborted') { sim.step({ recover: true }); state.paused = false; state.replayMode = false; }
    };
    $('speed').onchange = (e) => { state.speed = Number(e.target.value); };
    $('btnSelfTest').onclick = runSelfTest;

    window.addEventListener('keydown', (e) => {
      audio.ensure();
      const k = e.key.toLowerCase();
      if (k === ' ') { state.paused = !state.paused; e.preventDefault(); return; }
      if (state.scenario !== 'manual') return;
      if (k === 'a') state.manual.throttle = -1;
      if (k === 'd') state.manual.throttle = 1;
      if (k === 'w') state.manual.winch = 1;
      if (k === 's') state.manual.winch = -1;
      if (k === '1') state.manual.tool = 'locator';
      if (k === '2') state.manual.tool = 'cutter';
      if (k === '3') state.manual.tool = 'arm';
      if (k === 'p') state.manual.pump = !state.manual.pump;
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'a' || k === 'd') state.manual.throttle = 0;
      if (k === 'w' || k === 's') state.manual.winch = 0;
    });
  }

  async function runSelfTest() {
    const out = $('selfTest');
    out.textContent = '自检运行中…';
    const cases = [
      ['正常流程', Autopilot.runNormal, (r) => r.mode === 'complete' && !r.events.some((e) => e.kind === 'abort')],
      ['设备故障', Autopilot.runThrusterFault, (r) => r.events.some((e) => e.kind === 'fault') && r.mode === 'complete'],
      ['参数越限', Autopilot.runOverload, (r) => r.events.filter((e) => e.kind === 'abort').length >= 2 && r.mode === 'complete'],
      ['断缆恢复', Autopilot.runUmbilicalBreak, (r) => r.events.some((e) => e.reason === 'umbilical_break') && r.mode === 'complete']
    ];
    const lines = [];
    for (const [label, fn, assert] of cases) {
      const probe = new CableSim.Simulation();
      fn(probe);
      const rec = probe.exportRecord();
      const pass = assert(rec) && rec.invariantViolations.length === 0;
      const aborts = rec.events.filter((e) => e.kind === 'abort')
        .map((e) => `${e.reason}@${e.time}s`).join(', ') || '无';
      lines.push(`${pass ? '✓' : '✗'} ${label} | 中止: ${aborts} | 结束: ${rec.mode}@${rec.time}s`);
    }
    // 回放确定性
    const a = new CableSim.Simulation();
    Autopilot.runNormal(a);
    const recA = a.exportRecord();
    const b = new CableSim.Simulation();
    b.replayRecord(recA);
    lines.push(`${b.exportRecord().hash === recA.hash ? '✓' : '✗'} 操作回放指纹一致 (${recA.hash})`);
    out.textContent = lines.join('\n');
  }

  bind();
  loadScenario('normal');
  requestAnimationFrame(frame);

  // __APPEND__
})();
