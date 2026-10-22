/**
 * 结算页不许顶掉牌桌（issue #154）。
 *
 * ## 问题是什么
 *
 * 一局打完，`TableScreen` 直接 `return <GameOverPanel/>`，整块牌桌连同右侧战报
 * 一起被替换掉：`document.querySelector('[data-testid="log"]') === null`。
 * 而回放入口置灰（D-183），战报是本作**唯一**的复盘手段 —— 输了不知道为什么输，
 * 结算页上也没有任何本局数据（血量、回合数都不在）。
 *
 * ## 判据（都读几何 / DOM 事实，不读 class）
 *
 * 1. 结算出现后，战报 DOM 仍存在且可见（原始症状就是它消失）；
 * 2. 本局摘要三行存在且**读得出数值**：回合数、双方最终血量、终局成因；
 * 3. 战报**没被结算层压住** —— 战报列中心的 `elementFromPoint` 必须命中战报内部，
 *    而不是遮罩。只断言「DOM 存在」会放过「在但被盖住」；
 * 4. 结算可以收起再展开（收起后能看完整牌桌，还得回得来）。
 */

import { expect, test } from '@playwright/test';

import { startSoloGame } from './helpers.js';

/** 认输能把一局在 2 秒内结束掉，且不依赖牌序（起手好坏都成立）。 */
async function endByConcede(page: Awaited<ReturnType<typeof startSoloGame>>['page']) {
  await page.getByTestId('concede').click();
  await page.getByTestId('concede-confirm').click();
  await expect(page.getByTestId('game-result')).toHaveText('败北', { timeout: 20_000 });
}

test('结算不顶掉牌桌：战报仍在、给出本局摘要、可收起展开', async ({ browser }) => {
  const { page } = await startSoloGame(browser);
  await endByConcede(page);

  // ① 战报 DOM 还在 —— 旧实现下这里 `toHaveCount(0)`。
  await expect(page.getByTestId('log'), '结算后战报必须还在（唯一复盘手段）').toHaveCount(1);
  await expect(page.getByTestId('log')).toBeVisible();

  // ② 摘要三行：回合数 / 双方最终血量 / 成因
  await expect(page.getByTestId('result-turns')).toHaveText(/回合/);
  await expect(page.getByTestId('result-turns')).toHaveText(/\d/);
  await expect(page.getByTestId('result-hp')).toHaveText(/我方\s*\d+/);
  await expect(page.getByTestId('result-hp')).toHaveText(/对手\s*\d+/);
  await expect(page.getByTestId('end-reason')).toContainText('认输');

  // ③ 战报没被结算层盖住：中心点命中的是战报自己
  const logBox = await page.getByTestId('log').boundingBox();
  expect(logBox, '战报应有几何尺寸').not.toBeNull();
  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="log"]');
    if (!(el instanceof HTMLElement)) return 'missing';
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top === el || el.contains(top) ? 'log' : (top?.getAttribute('data-testid') ?? top?.className ?? 'other');
  });
  expect(hit, '战报中心必须点得到战报本体（不能被结算遮罩压住）').toBe('log');

  // ④ 收起 → 只剩一条细条 + 重新打开入口；展开后摘要回来
  await page.getByTestId('result-collapse').click();
  await expect(page.getByTestId('result-card')).toHaveCount(0);
  await expect(page.getByTestId('result-reopen')).toBeVisible();
  await page.getByTestId('result-reopen').click();
  await expect(page.getByTestId('result-card')).toBeVisible();
  await expect(page.getByTestId('result-turns')).toBeVisible();
});
