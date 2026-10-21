import { expect, test } from '@playwright/test';

import { phaseText, startSoloGame, turnNo } from './helpers.js';

/**
 * 人机对战（D-242）的开局路径。
 *
 * ## 为什么单独一个 spec
 *
 * 联机对局的 E2E 走 `startGame`（建房 + 加入 + 双方准备），而人机局是
 * 「建房即坐入 AI、AI 恒为已准备」，**开局链路不同**（`room.ts` 的 `solo` 分支）。
 * D-262 之前这条路径零覆盖，于是出现了一个联机永远测不出的 bug：
 * 人机局没有换牌阶段，开局直接跳到「第 2 回合 · 充能」。
 */

test('人机房开局停在换牌阶段，不是直接开打（D-262）', async ({ browser }) => {
  const { page } = await startSoloGame(browser, { skipMulligan: false });

  // ① 回合数显示「开局」—— 换牌阶段不属于任何回合
  await expect(page.getByTestId('turn')).toContainText('开局', { timeout: 15_000 });
  // ② 阶段进度条要多一枚「换牌」，否则六个格全灰、玩家以为没开始
  await expect(page.getByTestId('phase-track')).toContainText('换牌');
  // ③ 玩家有「不换牌」入口（按钮可见即代表这个阶段真的开着）
  await expect(page.getByTestId('mulligan-skip')).toBeVisible({ timeout: 15_000 });
  // ④ AI 必须**自己**提交过 —— 否则玩家要干等 30 秒换牌超时兜底
  await expect(page.getByTestId('log')).toContainText('完成换牌', { timeout: 15_000 });
});

test('点「不换牌」后进第 1 回合，而不是第 2 回合（D-262 回归点）', async ({ browser }) => {
  const { page } = await startSoloGame(browser, { skipMulligan: false });
  await page.getByTestId('mulligan-skip').click({ timeout: 15_000 });

  /*
   * 这里断言的是 **1**，不是「比之前大」。
   *
   * 修之前的表现正是「点完（或根本没机会点）直接显示第 2 回合」：
   * `advanceOnce` 用 `PHASE_ORDER.indexOf('mulligan')` = -1 落进了
   * 「结束阶段之后 → 进入下一回合」分支，把第一回合整个吃掉了。
   * 所以这条用例必须钉死具体回合号 —— 写成 `toBeGreaterThan(0)` 就抓不到。
   */
  await expect.poll(() => turnNo(page), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => phaseText(page), { timeout: 15_000 }).toContain('充能');
});
