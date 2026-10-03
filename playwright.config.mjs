import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  outputDir: '.artifacts/test-results/playwright',
  reporter: [['json', { outputFile: '.artifacts/test-results/browser.json' }], ['list']],
  use: { baseURL: 'http://127.0.0.1:4318', headless: true, ...(existsSync(edge) ? { channel: 'msedge' } : {}), launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } },
  webServer: { command: 'node backend/lab/main.mjs', url: 'http://127.0.0.1:4318/api/health', reuseExistingServer: false, env: { PORT: '4318', AGORA_LIVE_ENABLED: 'false', AGORA_APP_ID: '', AGORA_APP_CERTIFICATE: '', AGORA_CUSTOMER_ID: '', AGORA_CUSTOMER_SECRET: '' } },
});
