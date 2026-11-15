import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4189",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  webServer: {
    command: "npm run dev -- --port 4189 --strictPort",
    url: "http://127.0.0.1:4189",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
