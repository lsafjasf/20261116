const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "artifacts/playwright-report.json" }]],
  use: {
    baseURL: "http://127.0.0.1:45991",
    viewport: { width: 1440, height: 900 },
    headless: true
  },
  webServer: {
    command: "python3 -m http.server 45991 --bind 127.0.0.1",
    url: "http://127.0.0.1:45991",
    reuseExistingServer: true,
    timeout: 10000
  }
});
