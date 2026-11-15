export default {
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'artifacts/test-results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:47321',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:47321/health',
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
};
