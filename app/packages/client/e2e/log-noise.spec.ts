/**
 * 战报降噪（#157 / D-315）。
 *
 * 三条断言对应 issue 的三个子项：
 *  ① **分级**：机制行（阶段 / 重置 / 自动充能 / 上限）默认收起，靠「显示机制细节」打开；
 *  ② **合并**：一次支付的 N 张费用只留一行 `消耗 N 张费用`（这条的真正守卫是
 *     `log.test.ts` 的 `describeEvent → null`，这里只守「界面上确实看不到了」）；
 *  ③ **不透明**：390px 抽屉底板不能是半透明（牌桌文字会透上来）。
 *
 * 第 4 条「按回合折叠」没有做 —— 理由写在 D-315 的取舍里（机制行收起后已经不需要）。
 */

import { expect, test } from '@playwright/test';

import { startSoloGame } from './helpers.js';

/** 与其它 spec 同款：本地 15s，公网验证时由 `E2E_WAIT_MS` 放宽。 */
const WAIT = Number(process.env.E2E_WAIT_MS ?? 15_000);

test('机制行默认收起，点「显示机制细节」才出现（#157）', async ({ browser }) => {
  const { page } = await startSoloGame(browser);
  const log = page.getByTestId('log');
  const detail = page.getByTestId('log-detail');

  // 默认是收起的
  await expect(detail).toHaveText('显示机制细节');

  /*
   * 推一次阶段，制造一条**确定**的机制行（`阶段：X → Y`）。
   * 不依赖开局自动推进产生了哪些行 —— 那种「碰运气」的断言会随阶段瞬穿规则漂移。
   */
  const advance = page.getByTestId('advance');
  await expect(advance).toBeEnabled({ timeout: WAIT });
  await advance.click();
  await expect(log, '机制行默认不该出现在战报里').not.toContainText('阶段：', {
    timeout: 5_000,
  });

  // 打开后必须能看到 —— 证明它一直在，只是被收起，不是被丢掉
  await detail.click();
  await expect(detail).toHaveText('隐藏机制细节');
  await expect(log, '打开细节后应该看到阶段切换').toContainText('阶段：', { timeout: WAIT });

  // 再收回去，正文不受影响
  await detail.click();
  await expect(log).not.toContainText('阶段：', { timeout: 5_000 });
});

test('支付的 N 张费用合成一行，不再逐张列位移（#157）', async ({ browser }) => {
  const { page } = await startSoloGame(browser);
  const log = page.getByTestId('log');

  /*
   * 进到主要阶段并出一张 0 费随从：0 费**不消耗费用区**，
   * 所以这里换个更普遍的做法 —— 推到底直接读现有战报里有没有「逐张位移」。
   *
   * 断言写成「**任何时候都不该出现**」而不是「出牌后不该出现」：
   * 这条规则是全局的（`cost → graveyard` 一律不成行），不需要构造特定牌局，
   * 也就不会因为手牌随机而偶发。
   */
  await expect(page.getByTestId('turn')).toBeVisible({ timeout: WAIT });
  await expect(log).not.toContainText('费用区 → 弃牌区');
});

test('390px 日志抽屉底板不透明（#157）', async ({ browser }) => {
  const { page } = await startSoloGame(browser, {
    contextOptions: { viewport: { width: 390, height: 844 }, hasTouch: true },
  });
  await page.getByTestId('log-toggle').click();

  const log = page.getByTestId('log');
  await expect(log).toBeVisible({ timeout: WAIT });

  /*
   * 读**计算样式**的 background-color，要求 alpha === 1。
   * 不断言 class 字符串：`bg-slate-900/95` 改成 `bg-slate-950` 的差异
   * 在 class 层面看不出来，只有算出来的颜色能证明它真的不透明。
   * 也不用「看起来」判断 —— 5% 透明度的截图肉眼几乎看不出，但文字会透上来。
   */
  const alpha = await log.evaluate((el) => {
    const bg = getComputedStyle(el).backgroundColor.trim();
    // Tailwind v4 算出来是 `oklch(...)`，不是 rgb —— 只认 rgb 会拿到 NaN
    // （D-156 记过同一个坑：颜色一律不能假设是 rgb 三元组）。
    const rgb = /rgba?\(([^)]+)\)/.exec(bg);
    if (rgb) {
      const parts = rgb[1]!.split(',').map((x) => Number(x.trim()));
      return parts.length === 4 ? parts[3]! : 1;
    }
    // `oklch(L C H / A)` —— 有 `/` 才有 alpha，没有就是 1
    const slash = /\/\s*([\d.]+)\s*\)?$/.exec(bg);
    return slash ? Number(slash[1]) : 1;
  });
  expect(alpha, '抽屉底板必须完全不透明（牌桌文字不得透上来）').toBe(1);
});
