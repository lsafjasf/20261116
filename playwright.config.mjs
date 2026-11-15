import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  fullyParallel: false,
  reporter: "line",
  use: {
    baseURL: "http://127.0.0.1:5191",
    locale: "zh-CN",
    colorScheme: "light",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "PORT=5191 node scripts/serve.mjs",
    url: "http://127.0.0.1:5191",
    reuseExistingServer: true,
    timeout: 15_000
  }
});
