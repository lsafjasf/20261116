import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

const localChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
  join(userInfo().homedir, ".cache", "ms-playwright", "chromium-1255", "chrome-linux64", "chrome");
const executablePath = existsSync(localChromium) ? localChromium : undefined;

export default defineConfig({
  testDir: "./tests/ui",
  timeout: 45000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4190",
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
    launchOptions: { executablePath },
    screenshot: "only-on-failure",
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node server.mjs",
    url: "http://127.0.0.1:4190",
    reuseExistingServer: true,
    timeout: 15000
  }
});
