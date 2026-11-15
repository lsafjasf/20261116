import * as C from './config.js';

// Pressure curve export. One row per tick keeps the curve on the same
// timeline as inputs, shared state and collision events.
export function toCSV(recording) {
  const rows = [
    'tick,sim_seconds,pressure_kpa,channel_level,street_depth,heat_c,gate,pump'
  ];
  for (const m of recording.timeline.metrics) {
    rows.push(
      [
        m.tick,
        m.t,
        m.pressure,
        m.channel,
        m.street,
        m.heat,
        m.gate,
        m.pump
      ].join(',')
    );
  }
  return rows.join('\n');
}

export function toSVG(recording, width = 900, height = 320) {
  const metrics = recording.timeline.metrics;
  if (metrics.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const pad = 46;
  const tMax = metrics[metrics.length - 1].t;
  const pMax = Math.max(C.PRESSURE_CRITICAL * 1.2, ...metrics.map((m) => m.pressure));
  const x = (t) => pad + (t / tMax) * (width - pad * 2);
  const y = (p) => height - pad - (p / pMax) * (height - pad * 2);
  const path = metrics
    .map((m, i) => `${i === 0 ? 'M' : 'L'}${x(m.t).toFixed(1)},${y(m.pressure).toFixed(1)}`)
    .join(' ');
  const collisions = recording.timeline.events
    .filter((e) => e.type === 'structural_collision')
    .map(
      (e) =>
        `<circle cx="${x(e.simTime).toFixed(1)}" cy="${y(e.pressure).toFixed(1)}" r="3.5" fill="#e5484d"/>`
    )
    .join('');
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const gy = pad + f * (height - pad * 2);
      const label = (pMax * (1 - f)).toFixed(1);
      return `<line x1="${pad}" y1="${gy}" x2="${width - pad}" y2="${gy}" stroke="#263142" stroke-width="1"/><text x="8" y="${gy + 4}" fill="#8aa0b8" font-size="11">${label}</text>`;
    })
    .join('');
  const warnY = y(C.PRESSURE_WARN);
  const critY = y(C.PRESSURE_CRITICAL);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#0d1420"/>
${grid}
<line x1="${pad}" y1="${warnY}" x2="${width - pad}" y2="${warnY}" stroke="#f5a524" stroke-dasharray="6 4"/>
<line x1="${pad}" y1="${critY}" x2="${width - pad}" y2="${critY}" stroke="#e5484d" stroke-dasharray="6 4"/>
<path d="${path}" fill="none" stroke="#36b37e" stroke-width="1.8"/>
${collisions}
<text x="${pad}" y="22" fill="#e6edf3" font-size="14">${recording.scenario || 'pressure'} - pressure (kPa) vs time (s)</text>
<text x="${width - pad - 120}" y="${warnY - 4}" fill="#f5a524" font-size="11">warn ${C.PRESSURE_WARN}</text>
<text x="${width - pad - 140}" y="${critY - 4}" fill="#e5484d" font-size="11">critical ${C.PRESSURE_CRITICAL}</text>
</svg>`;
}

export function download(filename, content, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
