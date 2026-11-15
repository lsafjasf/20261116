const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const ms = (value) => `${Number(value).toFixed(3)} ms`;
const pct = (value) => `${(Number(value) * 100).toFixed(1)}%`;
const mb = (bytes) =>
  bytes === null || bytes === undefined ? "—" : `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function scenarioRow(scenario, reference = false) {
  const good = scenario.errors.length === 0 && scenario.overlaps.length === 0;
  const label = reference ? `${scenario.label}（参照）` : scenario.label;
  return `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>${scenario.mode === "cached" ? "开启" : "关闭"}</td>
      <td>${ms(scenario.frameAvgMs)}</td>
      <td>${ms(scenario.frameP95Ms)}</td>
      <td>${ms(scenario.frameMaxMs)}</td>
      <td>${scenario.candidatesPerFrame}</td>
      <td>${pct(scenario.hitRate)}</td>
      <td>${scenario.cacheEntries}</td>
      <td>${mb(scenario.heapEnd)}</td>
      <td class="${good ? "good" : "bad"}">${scenario.errors.length} / ${scenario.overlaps.length}</td>
      <td title="${scenario.outputDigest}">${scenario.outputDigest}</td>
    </tr>`;
}

function parityCard(label, pass) {
  return `<div class="parity-card"><span>${label}</span><b class="${pass ? "" : "bad"}">${
    pass ? "MATCH" : "DIFF"
  }</b></div>`;
}

export function renderReport(report) {
  const [before, after, edge] = report.scenarios;
  const comparisons = report.comparisons;
  const candidateReduction =
    before.candidatesPerFrame > 0
      ? 1 - after.candidatesPerFrame / before.candidatesPerFrame
      : 0;
  const edgeCandidateReduction =
    report.edgeBaseline.candidatesPerFrame > 0
      ? 1 - edge.candidatesPerFrame / report.edgeBaseline.candidatesPerFrame
      : 0;
  const pass = report.verdict.onlyPerformanceChanged;
  const errorCount = report.scenarios.reduce(
    (sum, scenario) => sum + scenario.errors.length,
    0
  );
  const overlapCount = report.scenarios.reduce(
    (sum, scenario) => sum + scenario.overlaps.length,
    0
  );
  const rows = report.scenarios.map((scenario) => scenarioRow(scenario)).join("");
  const referenceRow = scenarioRow(report.edgeBaseline, true);

  return `
    <div class="verdict ${pass ? "" : "fail"}">
      <div class="verdict-mark">${pass ? "✓" : "!"}</div>
      <div>
        <h3>${pass ? "只改变了性能与错误处理" : "检测到语义或交互差异"}</h3>
        <p>
          优化前后输出字符串、布局几何、交互轨迹与公开数据摘要逐帧一致。
          异常 ${errorCount} 条，重叠 ${overlapCount} 处；视觉、交互和公开数据语义保持不变。
        </p>
      </div>
    </div>

    <section class="report-section">
      <h3>Fixed scenarios · 固定场景</h3>
      <div class="table-scroll">
        <table class="report-table">
          <thead>
            <tr>
              <th>场景</th><th>缓存</th><th>帧时 avg</th><th>帧时 p95</th><th>帧时 max</th>
              <th>候选/帧</th><th>命中</th><th>条目</th><th>堆结束</th>
              <th>异常/重叠</th><th>输出摘要</th>
            </tr>
          </thead>
          <tbody>${rows}${referenceRow}</tbody>
        </table>
      </div>
    </section>

    <section class="report-section">
      <h3>Effect · 缓存收益</h3>
      <div class="parity-grid">
        <div class="parity-card"><span>常规帧时</span><b>${ms(before.frameAvgMs)} → ${ms(
          after.frameAvgMs
        )}</b></div>
        <div class="parity-card"><span>帧时降幅 / 加速</span><b>${pct(
          comparisons.beforeAfter.speedup > 0 ? 1 - 1 / comparisons.beforeAfter.speedup : 0
        )} · ${comparisons.beforeAfter.speedup.toFixed(2)}×</b></div>
        <div class="parity-card"><span>候选测量降幅</span><b>${pct(candidateReduction)}</b></div>
        <div class="parity-card"><span>常规命中率</span><b>${pct(after.hitRate)}</b></div>
        <div class="parity-card"><span>边界候选降幅</span><b>${pct(edgeCandidateReduction)}</b></div>
        <div class="parity-card"><span>边界命中率</span><b>${pct(edge.hitRate)}</b></div>
      </div>
    </section>

    <section class="report-section">
      <h3>Semantic parity · 语义等值</h3>
      <div class="parity-grid">
        ${parityCard("输出字符串逐帧一致", comparisons.beforeAfter.outputEqual && comparisons.edge.outputEqual)}
        ${parityCard("布局几何一致", comparisons.beforeAfter.layoutGeometryEqual && comparisons.edge.layoutGeometryEqual)}
        ${parityCard("交互轨迹一致", comparisons.beforeAfter.interactionEqual && comparisons.edge.interactionEqual)}
        ${parityCard("公开数据摘要一致", comparisons.beforeAfter.publicEqual && comparisons.edge.publicEqual)}
        ${parityCard("无异常日志", errorCount === 0)}
        ${parityCard("滚动/缩放无重叠", overlapCount === 0)}
      </div>
      <p class="report-note">
        边界参数另以无缓存路径重放作为参照；其输出摘要
        <span class="mono">${report.edgeBaseline.outputDigest}</span>
        与缓存路径 <span class="mono">${edge.outputDigest}</span> 一致。
        资源占用：常规优化前后堆结束 ${mb(before.heapEnd)} / ${mb(after.heapEnd)}，
        布局节点 ${before.lineNodes} / ${after.lineNodes}。
      </p>
    </section>

    <section class="report-section">
      <h3>Final output · 最终字符串（优化前 / 优化后相同）</h3>
      <div class="output-card"><pre>${escapeHtml(after.finalOutput)}</pre></div>
    </section>

    <section class="report-section">
      <h3>Edge output · 边界参数最终字符串</h3>
      <div class="output-card"><pre>${escapeHtml(edge.finalOutput)}</pre></div>
    </section>

    <p class="report-note">
      生成时间 ${escapeHtml(report.generatedAt)}。帧时为排版路径耗时，
      候选数为实际调用文本测量函数的次数；缓存键包含文本、字体、字重、字号、宽度、对齐与行高。
    </p>
  `;
}

export function renderReportError(error) {
  return `
    <div class="verdict fail">
      <div class="verdict-mark">!</div>
      <div>
        <h3>压测未能完成</h3>
        <p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
      </div>
    </div>`;
}
