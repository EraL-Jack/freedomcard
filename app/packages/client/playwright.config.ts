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
  // 默认 30s 太紧（D-316）：`chargeMinions` 现在会等播放队列排空再动下一步
  // （ADR-0078：队列没排空时客户端视图是旧的），这段等待是**合法耗时**，不是挂起。
  // 放不到这里的话，一个 25s 的用例会被「等正确的东西」顶过线。
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    /*
     * 只在 CI 留现场（D-316）。本地跑图省事、跑得快，trace 一直开着没必要；
     * CI 上恰恰相反 —— 失败如果没留下 trace，就只能对着两行 Call log 猜，
     * 2026-10-22 两次红都是这么白追的。
     *
     * `retain-on-failure`：跑的时候录，通过就丢，红的那条留着。
     * GitHub Actions 会置 `CI=true`，本地手动跑仍是一律不录。
     */
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: process.env.CI ? 'only-on-failure' : 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // 在 app/ 根执行（client/../.. = app），一次起 server(3000) 与 client(5173)
    command: 'pnpm dev',
    cwd: '../..',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    // ADR-0021：固定随机种子，使牌序与先后手确定，E2E 才能写确定断言。
    // 用 `env` 而非命令前缀，是因为 WebServer 在 Windows 下走 cmd.exe，
    // `VAR=x pnpm dev` 这种 shell 语法在那里不成立。
    env: { GAME_SEED: '20261013', TURN_TIMEOUT_MS: '120000' },
    // 实测（2026-10-13，Windows 11 / pnpm 12.11.2）：webServer 自行拉起
    // `pnpm -r --parallel dev` 时收不到就绪信号，会卡到 timeout；但服务本身能起来。
    // 因此本机 Windows 上改为先手动 `pnpm dev`，靠 reuseExistingServer 复用，已验证 3/3 通过。
    // CI（ubuntu-latest）由 webServer 自行拉起，行为另行观察。
  },
});
