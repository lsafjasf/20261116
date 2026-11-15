/* 主控：初始化、播放循环、事件绑定、下载/载入、统一 renderAll */
(function () {
  const APP = window.App;
  const $ = (id) => document.getElementById(id);
  const state = new APP.AppState();
  const mapView = new APP.MapView($('mapCanvas'));
  const audio = new APP.LoadAudio();
  let timer = null;

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function renderAll() {
    const ts = state.tickState();
    mapView.setModel({
      nodeById: Object.fromEntries(state.cleanDataset.nodes.map((n) => [n.id, n])),
      edges: state.cleanDataset.edges
    });
    mapView.draw(ts, state.filters);
    APP.Renderer.meta(state);
    APP.Renderer.kpis(state);
    APP.Renderer.nodeTable(state);
    APP.Renderer.edgeTable(state);
    APP.Renderer.debug(state);
    APP.Renderer.quarantine(state);
    APP.Renderer.exportSpec(state);
    $('tickSlider').max = state.tickCount - 1;
    $('tickSlider').value = state.currentTick;
    $('tickLabel').textContent = 'tick ' + state.currentTick;
    syncEdgeEditor();
  }

  function fillEdgeSelectors() {
    const opts = state.cleanDataset.edges.map((e) =>
      '<option value="' + e.id + '">' + e.id + '（' + e.from + '→' + e.to + '）</option>').join('');
    $('edgeFilter').innerHTML = '<option value="all">全部线路</option>' + opts;
    $('edgeSelect').innerHTML = opts;
  }

  function syncEdgeEditor() {
    const eid = $('edgeSelect').value;
    const edge = state.dataset.edges.find((e) => e.id === eid);
    if (!edge) return;
    $('capInput').value = edge.cap;
    $('prioInput').value = edge.prio;
    const edit = state.edgeEdits[eid];
    $('interventionInfo').textContent =
      (edit ? '当前为手动编辑值（已触发重算）\n' : '当前为清洗后基准值\n') +
      '断供事件：' + JSON.stringify(state.cleanDataset.events) + '\n' +
      '改道干预：' + JSON.stringify(state.cleanDataset.interventions);
  }

  function setPlaying(playing) {
    state.playing = playing;
    $('playBtn').textContent = playing ? '⏸ 暂停' : '▶ 播放';
    if (timer) { clearInterval(timer); timer = null; }
    if (playing) {
      timer = setInterval(() => {
        if (state.currentTick >= state.tickCount - 1) { setPlaying(false); return; }
        state.currentTick += 1;
        afterTick();
      }, 700 / state.speed);
    }
  }

  function afterTick() {
    mapView.advance(0.12 * state.speed);
    audio.update(state.tickState(), state.currentTick);
    renderAll();
  }

  function bind() {
    $('sampleSelect').value = state.sampleKey;
    $('sampleSelect').addEventListener('change', (e) => {
      state.reload(e.target.value);
      fillEdgeSelectors();
      renderAll();
    });
    $('interventionToggle').addEventListener('change', (e) => {
      state.simulationOptions.applyInterventions = e.target.checked;
      state.rerun();
      renderAll();
    });
    $('nodeTypeFilter').addEventListener('change', (e) => {
      state.setFilter('nodeType', e.target.value); renderAll();
    });
    $('edgeFilter').addEventListener('change', (e) => {
      state.setFilter('edge', e.target.value); renderAll();
    });
    $('shortageFilter').addEventListener('change', (e) => {
      state.setFilter('onlyShortage', e.target.checked); renderAll();
    });
    $('playBtn').addEventListener('click', () => setPlaying(!state.playing));
    $('stepBtn').addEventListener('click', () => {
      setPlaying(false);
      state.currentTick = Math.min(state.tickCount - 1, state.currentTick + 1);
      afterTick();
    });
    $('resetBtn').addEventListener('click', () => {
      setPlaying(false); state.currentTick = 0; renderAll();
    });
    $('speedSelect').addEventListener('change', (e) => {
      state.speed = parseFloat(e.target.value);
      if (state.playing) { setPlaying(false); setPlaying(true); }
    });
    $('tickSlider').addEventListener('input', (e) => {
      setPlaying(false);
      state.currentTick = parseInt(e.target.value, 10);
      renderAll();
    });
    $('audioBtn').addEventListener('click', () => {
      const on = audio.toggle();
      $('audioBtn').textContent = on ? '🔊 音效开' : '🔇 音效关';
    });
    $('edgeSelect').addEventListener('change', syncEdgeEditor);
    mapView.onSelect = (eid) => {
      if (!eid) return;
      $('edgeSelect').value = eid;
      syncEdgeEditor();
    };
    $('applyEdgeBtn').addEventListener('click', () => {
      const eid = $('edgeSelect').value;
      const cap = Math.max(1, parseInt($('capInput').value, 10) || 1);
      const prio = Math.min(99, Math.max(1, parseInt($('prioInput').value, 10) || 100));
      state.setEdge(eid, { cap, prio });
      renderAll();
    });
    $('resetEdgeBtn').addEventListener('click', () => {
      state.resetEdges(); renderAll();
    });

    $('exportNodeCsv').addEventListener('click', () => {
      const pack = state.exportPack();
      download(state.sampleKey + '-node-ledger.csv', pack.nodeCsv, 'text/csv;charset=utf-8');
      renderAll();
    });
    $('exportEdgeCsv').addEventListener('click', () => {
      const pack = state.exportPack();
      download(state.sampleKey + '-edge-ledger.csv', pack.edgeCsv, 'text/csv;charset=utf-8');
      renderAll();
    });
    $('exportMeta').addEventListener('click', () => {
      const pack = state.exportPack();
      download(state.sampleKey + '-export-meta.json', JSON.stringify(pack.meta, null, 2),
        'application/json');
      renderAll();
    });
    $('saveProjectBtn').addEventListener('click', () => {
      const project = state.saveProject();
      download(state.sampleKey + '-project.json', JSON.stringify(project),
        'application/json');
    });
    $('loadProjectInput').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          state.loadProject(JSON.parse(reader.result));
          $('sampleSelect').value = state.sampleKey;
          fillEdgeSelectors();
          renderAll();
          alert('工程载入成功，校验和已随重算复核。');
        } catch (err) {
          alert('载入失败：' + err.message);
        }
      };
      reader.readAsText(file);
    });
  }

  bind();
  fillEdgeSelectors();
  renderAll();
  window.__APP__ = { state, mapView, audio, renderAll };
})();
