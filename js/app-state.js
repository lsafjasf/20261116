/* 应用状态：样例 -> 清洗 -> 边编辑 -> 模拟 -> 校验和，单一数据流 */
(function (global) {
  const APP = global.App || (global.App = {});

  function AppState() {
    this.sampleKey = 'B';
    this.edgeEdits = {};
    this.filters = { nodeType: 'all', edge: 'all', onlyShortage: false };
    this.simulationOptions = { applyInterventions: true };
    this.currentTick = 0;
    this.playing = false;
    this.speed = 1;
    this.exportLog = [];
    this.reload();
  }

  AppState.prototype.reload = function (sampleKey) {
    if (sampleKey) this.sampleKey = sampleKey;
    const raw = APP.samples[this.sampleKey];
    this.rawDataset = raw;
    this.cleanDataset = APP.ingest.clean(raw);
    this.edgeEdits = {};
    this.currentTick = 0;
    this.rerun();
  };

  AppState.prototype._effectiveDataset = function () {
    const ds = JSON.parse(JSON.stringify(this.cleanDataset));
    Object.keys(this.edgeEdits).forEach((eid) => {
      const edge = ds.edges.find((e) => e.id === eid);
      if (edge) Object.assign(edge, this.edgeEdits[eid]);
    });
    return ds;
  };

  AppState.prototype.rerun = function () {
    this.dataset = this._effectiveDataset();
    this.result = APP.engine.run(this.dataset, this.simulationOptions);
    this.checksums = APP.exporting.checksums(this.result);
    this.tickCount = this.result.ledger.length;
    if (this.currentTick >= this.tickCount) this.currentTick = this.tickCount - 1;
    return this.result;
  };

  AppState.prototype.setEdge = function (eid, patch) {
    const base = this.dataset.edges.find((e) => e.id === eid);
    if (!base) return;
    this.edgeEdits[eid] = Object.assign({}, this.edgeEdits[eid], patch);
    this.rerun();
  };

  AppState.prototype.resetEdges = function () {
    this.edgeEdits = {};
    this.rerun();
  };

  AppState.prototype.setFilter = function (key, value) {
    this.filters[key] = value;
  };

  AppState.prototype.tickState = function (tick) {
    return this.result.ledger[tick == null ? this.currentTick : tick];
  };

  AppState.prototype.visibleNodes = function (tickState) {
    return tickState.nodes.filter((n) => {
      if (this.filters.nodeType !== 'all' && n.type !== this.filters.nodeType) return false;
      if (this.filters.onlyShortage && !(n.shortage > 0)) return false;
      return true;
    });
  };

  AppState.prototype.visibleEdges = function (tickState) {
    return tickState.edges.filter((e) =>
      this.filters.edge === 'all' || e.id === this.filters.edge);
  };

  AppState.prototype.exportPack = function () {
    const pack = APP.exporting.buildExport(this.result, this.filters, 'full-ledger');
    this.exportLog.unshift({
      at: new Date().toISOString(),
      scope: pack.meta.scope,
      nodeRows: pack.before.nodeRowCount,
      edgeRows: pack.before.edgeRowCount,
      consistent: pack.consistent
    });
    return pack;
  };

  AppState.prototype.saveProject = function () {
    return APP.exporting.buildProject({
      dataset: this.cleanDataset,
      result: this.result,
      edgeEdits: this.edgeEdits,
      filters: this.filters,
      simulationOptions: this.simulationOptions
    });
  };

  AppState.prototype.loadProject = function (project) {
    if (project.format !== 'logistics-sim-project') throw new Error('工程格式不识别');
    this.cleanDataset = APP.ingest.clean(project.dataset);
    this.edgeEdits = project.edgeEdits || {};
    this.filters = project.filters || this.filters;
    this.simulationOptions = project.simulationOptions || this.simulationOptions;
    this.sampleKey = project.dataset.id || this.sampleKey;
    this.currentTick = 0;
    this.rerun();
  };

  APP.AppState = AppState;
})(typeof window !== 'undefined' ? window : globalThis);
