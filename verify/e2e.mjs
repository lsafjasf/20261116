// Browser end-to-end verification with Puppeteer.
// Boots the real UI, records a chord+glide performance via keyboard events,
// verifies WAV export, pause/resume, snapshot restore, and node hygiene.
// Run: node verify/e2e.mjs  (requires `npm i` and a local static server)
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 8123;
const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
await sleep(800);

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + detail}`);
  if (!cond) failures++;
};

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle0' });
  check('e2e: page loads without errors', errors.length === 0, errors.join('; '));

  // Enable glide on key 4 (D key / index 3) via the panel.
  await page.keyboard.press('4'); // select key index 3
  await page.$eval('#p-glide', (el) => {
    el.value = '0.4';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Record: chord (A+S+F) then a glide phrase on D.
  await page.click('#btn-record');
  await sleep(500);
  for (const k of ['a', 's', 'f']) await page.keyboard.down(k);
  await sleep(1200);
  for (const k of ['a', 's', 'f']) await page.keyboard.up(k);
  await sleep(300);
  await page.keyboard.down('d');
  await sleep(400);
  await page.keyboard.up('d');
  // Change pitch offset so the retrigger glides.
  await page.$eval('#p-pitch', (el) => {
    el.value = '2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.down('d');
  await sleep(600);
  await page.keyboard.up('d');
  await page.click('#btn-record'); // stop recording
  await sleep(400); // allow a rAF status refresh

  const recInfo = await page.evaluate(() => {
    const info = document.getElementById('transport-info').textContent;
    const status = document.getElementById('status').textContent;
    return { info, status };
  });
  check('e2e: performance recorded', /已录 \d+ 事件/.test(recInfo.info), recInfo.info);

  // Playback + pause: no tail (nodes collected shortly after pause).
  await page.click('#btn-play');
  await sleep(700);
  await page.click('#btn-pause');
  await sleep(600);
  const afterPause = await page.evaluate(
    () => document.getElementById('status').textContent
  );
  check('e2e: pause leaves zero active nodes', /节点:0 /.test(afterPause), afterPause);
  check('e2e: pause shows no playing flag', !/播放:PLAY/.test(afterPause), afterPause);

  // Resume then stop.
  await page.click('#btn-play');
  await sleep(400);
  const resumed = await page.evaluate(
    () => document.getElementById('status').textContent
  );
  check('e2e: resume restarts scheduler', /调度:on/.test(resumed), resumed);
  await page.click('#btn-stop');

  // Snapshot save -> mutate -> restore -> params identical.
  const before = await page.evaluate(() => {
    const g = (id) => document.getElementById(id).value;
    return { glide: g('p-glide'), pitch: g('p-pitch') };
  });
  await page.click('#btn-snap-save');
  await page.$eval('#p-glide', (el) => {
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#btn-snap-load');
  const after = await page.evaluate(() => {
    const g = (id) => document.getElementById(id).value;
    return { glide: g('p-glide'), pitch: g('p-pitch') };
  });
  check('e2e: snapshot restore keeps panel params',
    before.glide === after.glide && before.pitch === after.pitch,
    JSON.stringify({ before, after }));

  // WAV export: capture the downloaded file.
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: '/tmp/synth-e2e',
  });
  await page.click('#btn-export');
  await sleep(1500);
  const fs = await import('node:fs');
  const files = fs.existsSync('/tmp/synth-e2e') ? fs.readdirSync('/tmp/synth-e2e') : [];
  const wavFile = files.find((f) => f.endsWith('.wav'));
  check('e2e: WAV file exported', !!wavFile, files.join(','));
  if (wavFile) {
    const buf = fs.readFileSync(`/tmp/synth-e2e/${wavFile}`);
    const dataSize = buf.readUInt32LE(40);
    const secs = dataSize / 4 / 44100;
    check('e2e: WAV header + 16s duration',
      buf.toString('ascii', 0, 4) === 'RIFF' && Math.abs(secs - 16) < 0.01,
      `secs=${secs}`);
  }

  // Reload the page: app boots cleanly again (no leaked global state).
  await page.reload({ waitUntil: 'networkidle0' });
  check('e2e: reload without errors', errors.length === 0, errors.join('; '));
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? '\nE2E ALL PASSED' : `\nE2E ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
