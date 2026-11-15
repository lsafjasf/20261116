// 工程存档：完整保存样例、权重、封路、筛选与视图设置，可重新载入复现

export const PROJECT_SCHEMA = 'traffic-sim-project/v1';

export function buildProject(state) {
  return {
    schema: PROJECT_SCHEMA,
    savedAt: new Date().toISOString(),
    dataVersion: state.dataVersion,
    sampleId: state.sampleId,
    dataset: state.dataset,
    sanitizeIssues: state.sanitizeIssues,
    overrides: {
      weights: state.overrides.weights,
      closures: state.overrides.closures,
    },
    filters: { ...state.filters },
    selectedVehicleId: state.selectedVehicleId,
    selectedEdgeId: state.selectedEdgeId,
    heatmapEnabled: state.heatmapEnabled,
  };
}

export function parseProject(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  if (obj.schema !== PROJECT_SCHEMA) {
    throw new Error(`工程版本不匹配：期望 ${PROJECT_SCHEMA}，实际 ${obj.schema || '缺失'}`);
  }
  if (!obj.dataset || !Array.isArray(obj.dataset.nodes) || !Array.isArray(obj.dataset.edges)) {
    throw new Error('工程内容不完整：缺少路网数据');
  }
  return {
    sampleId: obj.sampleId || 'custom',
    dataset: obj.dataset,
    sanitizeIssues: obj.sanitizeIssues || [],
    overrides: {
      weights: obj.overrides?.weights || {},
      closures: Array.isArray(obj.overrides?.closures) ? obj.overrides.closures : [],
    },
    filters: obj.filters || {},
    selectedVehicleId: obj.selectedVehicleId || null,
    selectedEdgeId: obj.selectedEdgeId || null,
    heatmapEnabled: obj.heatmapEnabled === true,
    dataVersion: obj.dataVersion || 1,
    savedAt: obj.savedAt || null,
  };
}

// 数据版本：每次结构变化（换样例/权重/封路）递增，并给出可读变更原因
export function bumpVersion(current, reason) {
  return {
    version: current.version + 1,
    reason,
    at: new Date().toISOString(),
    history: [...current.history, { version: current.version + 1, reason, at: new Date().toISOString() }],
  };
}
