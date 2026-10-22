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
  /*
   * 重试（D-316）：**不是用来掩盖缺陷的，是用来吸收「运行环境」的抖动。**
   *
   * 2026-10-22 的 CI 上，同一条用例在 7 分钟的机器上稳定通过、在 16 分钟的机器上
   * 卡在 `waiting for element to be visible, enabled and stable` 直到超时 ——
   * 那不是断言写错，是 runner 太慢导致 actionability 检查迟迟出不了结论。
   *
   * 真缺陷不会被重试放过：三次都红还是红。而「一次抖动 = 一个红 PR」的代价太高
   * （ADR-0081：宁可制造可重试的假红，也不要制造阻塞）。
   */
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    /*
     * 全场关掉动效：`prefers-reduced-motion` 在 `style.css` 里有对应的 CSS
     * （不只服务测试，也服务真开了「减少动态效果」的用户）。
     * 无限循环的 `animate-pulse` 正是「等不到稳定」的元凶。
     */
    reducedMotion: 'reduce',
    /*
     * **在第一次重试时才录 trace**（D-316）：
     * - `retain-on-failure` 会每次都录，CI 里把 16 分钟的活拖成 20 分钟，
     *   机器越慢越容易抖 —— 录现场本身变成了制造现场；
     * - `on-first-retry` 让正常路径保持轻量，抖了那一次仍然留得下 trace。
     * 本地（无 CI 环境变量）一律不录。
     */
    trace: process.env.CI ? 'on-first-retry' : 'off',
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
