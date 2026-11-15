import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required"]
    }
  },
  webServer: {
    command: "node scripts/server.mjs",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true
  }
});
