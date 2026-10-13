import { defineConfig, devices } from '@playwright/test';

/**
 * 端到端配置。
 *
 * `webServer` 起的是**开发态**（Vite + 服务端并行），因此 E2E 跑的是真实联机链路。
 * 生产形态（`SERVE_STATIC=1`）的验证见 `README-运行说明.md` §6，不在此覆盖。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // 房间流程依赖两个上下文的时序，串行更稳
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // 在 app/ 根执行（client/../.. = app），一次起 server(3000) 与 client(5173)
    command: 'pnpm dev',
    cwd: '../..',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    // 实测（2026-10-13，Windows 11 / pnpm 12.11.2）：webServer 自行拉起
    // `pnpm -r --parallel dev` 时收不到就绪信号，会卡到 timeout；但服务本身能起来。
    // 因此本机 Windows 上改为先手动 `pnpm dev`，靠 reuseExistingServer 复用，已验证 3/3 通过。
    // CI（ubuntu-latest）由 webServer 自行拉起，行为另行观察。
  },
});
