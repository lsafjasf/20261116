const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:47654",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "python3 -m http.server 47654 --bind 127.0.0.1",
    url: "http://127.0.0.1:47654",
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
