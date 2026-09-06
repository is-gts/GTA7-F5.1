import { defineConfig } from '@playwright/test';

/**
 * End-to-end smoke tests run the *built* game (dist/) in headless Chromium with SwiftShader,
 * so they work on CI machines without a GPU. Run `npm run build` first (npm run verify does).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 90_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: './output/test-results',
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: false,
    timeout: 60_000,
    cwd: '..',
  },
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    viewport: { width: 960, height: 540 },
    launchOptions: {
      args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-vsync'],
    },
  },
});
