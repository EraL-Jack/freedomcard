import { expect, test, type Page } from '@playwright/test';

import { startGame } from './helpers.js';

/**
 * E2E 的确定性守卫（ADR-0021 / issue #149）。
 *
 * ## 为什么需要这条
 *
 * `playwright.config.ts` 的 `webServer.env` 里写着 `GAME_SEED=20261013`，
 * 但同一份配置也开了 `reuseExistingServer: true` —— 这在 Windows 上是必须的
 * （配置注释里写了：webServer 自行拉起时会收不到就绪信号，卡到 timeout）。
 *
 * 两者的组合有个**静默陷阱**：5173 上如果已经有人在跑（最常见的就是手动
 * `pnpm dev` 想边调边看），Playwright 直接复用那个进程，那份 `env` 根本不会生效。
 * 测试照样跑，只是牌序变成随机的。
 *
 * 牌序随机之后，失败长这样：
 *
 * ```
 * Error: 手牌里应有付得起的法术（费用区 7 张、本回合额度 1）
 * Received: undefined
 * ```
 *
 * 读起来像引擎坏了，实际只说明这局起手不好。它已经误伤过一次 —— D-290 的全量跑
 * 出现 1 红，最后靠人工复跑 3 次才排除。**偶发的红最大的代价不是红本身，
 * 是让人开始不信红。**
 *
 * ## 为什么用「两局起手必须一致」而不是别的
 *
 * 固定种子最直接的可观测后果就是「同样的开局重复出现」。这条断言不依赖任何内部字段、
 * 不需要服务端暴露 seed，而且它的失败信息就是诊断结论本身。
 *
 * ⚠️ 它**不**覆盖「seed 一样但洗牌算法变了」—— 那是 `core` 单测的事（`rng.test.ts`）。
 * 这里只回答一个问题：此刻跑 E2E 的这台服务端，是不是确定性的。
 */
test('连开两局起手完全一致 —— E2E 必须跑在固定种子下', async ({ browser }) => {
  test.setTimeout(120_000);

  const handOf = async (page: Page): Promise<string> =>
    (await page.getByTestId('hand').locator('[data-testid="card"]').allInnerTexts())
      .map((t) => t.split('\n')[0]?.trim() ?? '')
      .join(' | ');

  const first = await startGame(browser);
  const a = await handOf(first.host);
  const second = await startGame(browser);
  const b = await handOf(second.host);

  expect(
    b,
    '两局起手不同 —— 复用的 dev server 没带 GAME_SEED，牌序是随机的。\n' +
      '修法二选一：\n' +
      '  ① 停掉手动起的 `pnpm dev`，让 Playwright 按 `webServer` 自己拉起（env 会注入 seed）；\n' +
      '  ② 手动起时带全：GAME_SEED=20261013 TURN_TIMEOUT_MS=120000 pnpm dev\n' +
      `第一局：${a}\n第二局：${b}`,
  ).toBe(a);
});
