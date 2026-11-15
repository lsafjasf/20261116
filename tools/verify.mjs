import { chromium } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ffprobePath from "ffprobe-static";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:48881";
const OUT = join(process.cwd(), "artifacts");
const reports = [];
const artifacts = {};

const isServerUp = async () => {
  try {
    const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
};

let serverProcess = null;
if (!(await isServerUp())) {
  const port = new URL(BASE_URL).port || "80";
  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: port },
    stdio: "ignore"
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isServerUp()) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!(await isServerUp())) throw new Error(`Verification server did not start at ${BASE_URL}`);

const check = (name, ok, details = {}) => {
  reports.push({ name, ok: Boolean(ok), details });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  return Boolean(ok);
};

const runFfprobe = (args) => JSON.parse(execFileSync(ffprobePath.path, ["-v", "error", ...args], {
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024
}));

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  acceptDownloads: true
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.stack || error.message));

const ready = async () => {
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true", { timeout: 20000 });
  await page.waitForTimeout(250);
};
const evidence = () => page.evaluate(() => window.__kinetic.getVerification());

try {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await ready();
  let app = await evidence();
  check("Two saved length variants exist", app.instances.length === 2 && app.instances[0].title.length !== app.instances[1].title.length, {
    short: app.instances.find((item) => item.variant === "short")?.title,
    long: app.instances.find((item) => item.variant === "long")?.title
  });
  check("Sample A handles null, duplicate and outlier", app.data.quality.nulls === 1 && app.data.quality.duplicates === 1 && app.data.quality.outliers === 1, app.data.quality);
  check("Sample A deduplicates 6 source rows to 5", app.data.rawCount === 6 && app.data.acceptedCount === 5, app.data);
  const shortLayout = app.layout;
  await page.screenshot({ path: join(OUT, "01-short-copy.png"), fullPage: true });
  artifacts.shortScreenshot = "artifacts/01-short-copy.png";

  await page.click('button[data-variant="long"]');
  await page.waitForTimeout(250);
  app = await evidence();
  const longLayout = app.layout;
  check("Long copy triggers adaptive multi-line layout", longLayout.lines.length >= 2 && longLayout.fontSize <= shortLayout.fontSize, {
    short: { lines: shortLayout.lines.length, size: shortLayout.fontSize },
    long: { lines: longLayout.lines.length, size: longLayout.fontSize }
  });
  await page.screenshot({ path: join(OUT, "02-long-copy.png"), fullPage: true });
  artifacts.longScreenshot = "artifacts/02-long-copy.png";

  await page.click('button[data-sample="B"]');
  await page.waitForTimeout(250);
  const sampleB = await evidence();
  check("Sample B independently handles null, duplicate and outliers", sampleB.data.quality.nulls === 1 && sampleB.data.quality.duplicates === 1 && sampleB.data.quality.outliers >= 1, sampleB.data.quality);
  check("Data views update together on sample switch", (await page.textContent("#dataVersion")).includes("v2026.11.16-B"), {
    header: await page.textContent("#dataVersion"),
    binding: await page.textContent("#binding1")
  });
  await page.screenshot({ path: join(OUT, "03-sample-b.png"), fullPage: true });
  artifacts.sampleBScreenshot = "artifacts/03-sample-b.png";

  await page.selectOption("#filterSelect", "设计系统");
  await page.waitForTimeout(180);
  const filtered = await evidence();
  check("Current filter is visible and applied", filtered.data.filter === "设计系统" && (await page.textContent("#filterValue")).includes("设计系统"), {
    filter: filtered.data.filter,
    label: await page.textContent("#filterValue"),
    scope: await page.textContent("#exportScope")
  });
  await page.selectOption("#filterSelect", "all");
  await page.waitForTimeout(150);

  const beforeRefresh = await evidence();
  await page.click("#refreshDataBtn");
  await page.waitForTimeout(250);
  const afterRefresh = await evidence();
  check("Data mutation propagates to every view", afterRefresh.data.revision === 1 && afterRefresh.data.version !== beforeRefresh.data.version && afterRefresh.preExport === null, {
    before: beforeRefresh.data.version,
    after: afterRefresh.data.version,
    debug: await page.textContent("#aggregateDebug")
  });

  await page.click('button[data-sample="A"]');
  await page.click('button[data-variant="long"]');
  await page.click('.tabs[data-tabs="inspector"] button[data-tab="keys"]');
  await page.click('#keyframeList .key-row[data-index="2"]');
  await page.fill("#keyXInput", "128");
  await page.fill("#keyYInput", "-14");
  await page.locator("#keyOpacityInput").evaluate((element) => { element.value = "1"; });
  await page.locator("#keyColorInput").evaluate((element) => { element.value = "#ff7048"; });
  await page.click("#applyKeyframeBtn");
  await page.waitForTimeout(180);
  app = await evidence();
  check("Editable keyframes control color, position and opacity", app.template.keyframes[2].x === 128 && app.template.keyframes[2].y === -14 && app.template.keyframes[2].opacity === 1, app.template.keyframes[2]);
  await page.click('.tabs[data-tabs="inspector"] button[data-tab="params"]');

  await page.click("#saveTemplateBtn");
  await page.waitForTimeout(250);
  app = await evidence();
  check("Template reload preserves both instance references", app.reloadAudit?.preserved === true && app.reloadAudit.after.linked.length === 2, app.reloadAudit);
  await page.click("#saveInstancesBtn");
  await page.waitForTimeout(200);
  app = await evidence();
  check("Two instances persist separately from template", app.audit.ok && app.instances.length === 2, { audit: app.audit, storage: await page.evaluate(() => ({
    template: Boolean(localStorage.getItem("kinetic.template.v1")),
    instances: Boolean(localStorage.getItem("kinetic.instances.v1"))
  })) });

  await page.evaluate(() => window.__kinetic.saveProject());
  check("Reloadable project stored before export", await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem("kinetic.project.v1"));
    return project.schema === "kinetic.project/v1" && project.templateId === project.template.id && project.instances.length === 2;
  }));

  const downloadPromise = page.waitForEvent("download", { timeout: 35000 });
  await page.click("#exportBtn");
  const download = await downloadPromise;
  const videoPath = join(OUT, "atlas-long-vp9-12s.webm");
  await download.saveAs(videoPath);
  artifacts.video = "artifacts/atlas-long-vp9-12s.webm";
  await page.waitForFunction(() => window.__kinetic.getVerification().export !== null, { timeout: 10000 });
  await page.click('.debug-tabs button[data-tab="integrity"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, "04-export-integrity.png"), fullPage: true });
  artifacts.integrityScreenshot = "artifacts/04-export-integrity.png";
  app = await evidence();
  check("Export before/after object counts and key values match", app.comparison?.ok === true, {
    comparison: app.comparison,
    pre: app.preExport,
    post: app.postExport
  });
  check("Exporter reports video and audio tracks", app.export?.videoTrack.present && app.export?.audioTrack.present, app.export);
  check("WebM duration metadata patched to 12s", app.export?.durationPatched === true, { durationMs: app.export?.durationMs });

  const projectDownloadPromise = page.waitForEvent("download", { timeout: 15000 });
  await page.click("#saveProjectBtn");
  const projectDownload = await projectDownloadPromise;
  const projectPath = join(OUT, "atlas-project.json");
  await projectDownload.saveAs(projectPath);
  artifacts.project = "artifacts/atlas-project.json";
  const savedProject = JSON.parse(await (await import("node:fs/promises")).readFile(projectPath, "utf8"));
  check("Saved project contains export audit and two linked instances", savedProject.verification?.exportComparison?.ok === true && savedProject.instances.every((item) => item.templateId === savedProject.templateId), {
    projectSchema: savedProject.schema,
    templateId: savedProject.templateId,
    instances: savedProject.instances.map((item) => ({ id: item.id, templateId: item.templateId }))
  });

  const probe = runFfprobe([
    "-count_frames",
    "-show_entries",
    "format=duration,size,format_name:stream=index,codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,sample_rate,channels",
    "-of", "json", videoPath
  ]);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format.duration);
  const frames = Number(video?.nb_read_frames);
  const decodedFps = frames / duration;
  check("WebM reports 12.00 seconds", Math.abs(duration - 12) <= 0.08, { duration });
  check("WebM contains VP9 1280x720 at 30fps decoded cadence", video?.codec_name === "vp9" && video?.width === 1280 && video?.height === 720 && Math.abs(decodedFps - 30) <= 0.25, {
    video,
    decodedFps: Number(decodedFps.toFixed(3))
  });
  check("Video has complete 12s frame coverage with no dropped frames", frames >= 360 && frames <= 361, { frames, nominalFrames: 360, tolerance: "final-boundary frame" });
  check("WebM contains Opus 48kHz stereo audio", audio?.codec_name === "opus" && Number(audio?.sample_rate) === 48000 && Number(audio?.channels) === 2, audio);

  const audioPackets = JSON.parse(execFileSync(ffprobePath.path, [
    "-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time,duration_time",
    "-of", "json", videoPath
  ], { encoding: "utf8" })).packets.map((packet) => ({
    pts: Number(packet.pts_time),
    duration: Number(packet.duration_time)
  }));
  const lastAudio = audioPackets.at(-1);
  check("Audio stream reaches the export tail", lastAudio && lastAudio.pts + (lastAudio.duration || 0) >= 11.9, {
    packetCount: audioPackets.length,
    first: audioPackets[0],
    last: lastAudio
  });

  await page.reload({ waitUntil: "networkidle" });
  await ready();
  app = await evidence();
  check("Page reload restores template and instance links", app.audit.ok && app.audit.linked.length === 2, app.audit);
  await page.click('.debug-tabs button[data-tab="references"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, "05-reloaded-references.png"), fullPage: true });
  artifacts.referencesScreenshot = "artifacts/05-reloaded-references.png";

  await page.setInputFiles("#projectFileInput", projectPath);
  await page.waitForTimeout(600);
  app = await evidence();
  check("Downloaded project reloads with no orphaned instances", app.audit.ok && app.instances.every((item) => item.templateId === app.template.id), app.audit);
  check("No browser runtime errors", consoleErrors.length === 0, { consoleErrors });

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    allChecksPassed: reports.every((item) => item.ok),
    checks: reports,
    app: {
      template: app.template,
      instances: app.instances,
      data: app.data,
      audit: app.audit,
      reloadAudit: app.reloadAudit,
      preExport: app.preExport,
      postExport: app.postExport,
      comparison: app.comparison,
      export: app.export
    },
    ffprobe: {
      format: probe.format,
      video,
      audio,
      audioPackets: {
        count: audioPackets.length,
        first: audioPackets[0],
        last: lastAudio
      }
    },
    artifacts
  };
  await writeFile(join(OUT, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  artifacts.verification = "artifacts/verification.json";
  console.log(`\nALL CHECKS: ${report.allChecksPassed ? "PASS" : "FAIL"}`);
  if (!report.allChecksPassed) process.exitCode = 1;
} finally {
  await browser.close();
  serverProcess?.kill("SIGTERM");
}
