import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  fullyParallel: false,
  reporter: [["list"], ["json", { outputFile: "artifacts/report.json" }]],
  use: {
    headless: true,
    actionTimeout: 15000,
    baseURL: "http://127.0.0.1:8731",
  },
  webServer: {
    command: "node tests/server.mjs",
    url: "http://127.0.0.1:8731/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 20000,
  },
});
