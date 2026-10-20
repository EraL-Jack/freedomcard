import { defineConfig, devices } from '@playwright/test';

/**
 * 临时配置：把 E2E 指向**公网地址**，用于验证穿透后的真实链路。
 *
 * 与主 `playwright.config.ts` 的区别：
 * - 不启 `webServer`（服务与隧道由外部提供）；
 * - baseURL 走环境变量 `PUBLIC_URL`；
 * - 超时放宽 —— 请求要绕一圈公网出口，比本机直连慢得多。
 *
 * 用法：PUBLIC_URL=https://xxx pnpm exec playwright test --config=playwright.public.config.ts room.spec.ts
 */
const baseURL = process.env.PUBLIC_URL ?? 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 150_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
