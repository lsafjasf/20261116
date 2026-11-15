export function drawDebug(ctx, opts) {
  const { width, height, snapshot } = opts;
  const { clean, stats, debugLog, window: win } = snapshot;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b111c';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#7ee787';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('DEBUG 面板（中间计算状态）', 10, 18);

  ctx.font = '11px monospace';
  const a = clean.audit;
  const headerLines = [
    `raw=${a.rawCount} unique=${a.uniqueSlots} dupDropped=${a.duplicateDropped}`,
    `quarantine=${a.quarantined} missingNulls=${a.missingNulls} outlierNulls=${a.outlierNulls}`,
    `window=${win.id}[${win.start}-${win.end}] gaps=${stats.gaps.length} peaks=${stats.peaks.length}`,
    ''
  ];

  const gapLines = stats.gaps.slice(0, 4)
    .map((g) => `gap ${g.stationId}.${g.field} [${g.start}-${g.end}]`);
  const recent = debugLog.slice(-8).map((e) => {
    const d = e.detail;
    return `> ${e.event}:${d.reason ?? ''} cur=${d.cursorHour ?? '-'} gaps=${d.gapCount ?? '-'} peaks=${d.peakCount ?? '-'}`;
  });

  const fixed = [...headerLines, ...gapLines, ''];
  const remaining = Math.max(0, Math.floor((height - 60) / 15) - fixed.length);
  const visible = [...fixed, ...recent.slice(-remaining)];
  visible.forEach((line, i) => {
    ctx.fillStyle = line.startsWith('>') ? '#8ecae6' : '#b9c4d1';
    ctx.fillText(line.slice(0, 78), 10, 38 + i * 15);
  });

  ctx.fillStyle = '#5d6b7d';
  ctx.fillText(`完整事件同步写入 window.__DEBUG__（共 ${debugLog.length} 条，仅展示最新）`,
    10, height - 6);
}
