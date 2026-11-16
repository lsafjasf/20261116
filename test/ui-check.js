// Captures HUD evidence in RUNNING and LOST phases (kept as a separate,
// optional visual check; the main regression gate is harness.js).
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { startServer } from "./server.js";

const chromeBin = process.env.CHROME_BIN;
const { server, url } = await startServer();
const browser = await chromium.launch({
  headless: true,
  ...(chromeBin ? { executablePath: chromeBin } : {}),
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
await page.goto(`${url}?mode=optimized&scene=optimized`);
await page.waitForFunction(() => window.__engine && window.__engine.phase === "RUNNING");
await page.waitForTimeout(300);
await mkdir("artifacts/ui", { recursive: true });
await page.screenshot({ path: "artifacts/ui/hud-running.png" });

await page.evaluate(async () => {
  window.__engine.loseContextExt.loseContext();
  await new Promise((resolve) => {
    const check = () => (window.__engine.phase === "LOST" ? resolve() : setTimeout(check, 20));
    check();
  });
  window.__engine.attemptRenderWhileLost();
});
await page.waitForTimeout(150);
await page.screenshot({ path: "artifacts/ui/hud-lost.png" });
const hud = await page.evaluate(() => ({
  badge: document.getElementById("status-badge").textContent,
  blocked: document.getElementById("m-blocked").textContent,
  overlayHidden: document.getElementById("lost-overlay").classList.contains("hidden"),
}));
console.log(JSON.stringify(hud));
await browser.close();
server.close();
