/**
 * 再来一局（D-309 / #125）。
 *
 * ## 要证明什么
 *
 * 打完一局之后最常见的下一步是「再打一局」，而原来的结算页只有一个「返回主界面」，
 * 回去之后要重新建房 / 加入 / 等对手 —— 连试一套卡组的成本高到会让人不想再试。
 *
 * 这一组钉住四条**行为**（都读界面事实，不读 class）：
 *
 * 1. 结算页有「再来一局」，且与「返回主界面」有主次（计算样式层面不同）；
 * 2. 点了直接进**新一局**：换牌阶段重新出现、结算消失、轮到「第 1 回合」；
 * 3. 联机必须双方都点：一方点完看到「等待对手确认」，另一方看到「对手想再来一局」；
 * 4. 对手离开后按钮**不可点**且写明原因 —— 不许静默失败。
 *
 * ## 为什么不在这里验「两份独立回放」
 *
 * 回放落在服务端 `app/replays/`，E2E 进程看不到；那份验收由
 * `reports/test/T-0040` 的手工取证（连打两局后 `ls -lt replays/`）承担。
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { startGame, startSoloGame } from './helpers.js';

const WAIT = Number(process.env.E2E_WAIT_MS ?? 20_000);

/** 认输把这局结束掉 —— 与牌序无关，起手好坏都成立。 */
async function concede(page: Page): Promise<void> {
  await page.getByTestId('concede').click();
  await page.getByTestId('concede-confirm').click();
  await expect(page.getByTestId('game-result')).toBeVisible({ timeout: WAIT });
}

test('人机局：结算页「再来一局」直接开新的一局', async ({ browser }) => {
  const { page } = await startSoloGame(browser);
  await concede(page);

  const rematch = page.getByTestId('rematch');
  await expect(rematch, '结算页必须有「再来一局」').toBeVisible();
  await expect(rematch).toHaveText('再来一局');
  // 人机房 AI 不会点按钮 —— 玩家点一次就该开，不该出现「等待对手确认」
  await expect(rematch).toBeEnabled();

  // 主次（验收 1）：主按钮的字重与底色都要与「返回主界面」不同。
  // 读计算样式而不是 class —— class 改名不该让这条断言失效，视觉退化才该。
  const style = await page.evaluate(() => {
    const pick = (id: string) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!(el instanceof HTMLElement)) return null;
      const cs = getComputedStyle(el);
      return { weight: Number(cs.fontWeight), bg: cs.backgroundColor };
    };
    return { main: pick('rematch'), back: pick('back-home') };
  });
  expect(style.main, 'rematch 按钮应存在').not.toBeNull();
  expect(style.back, 'back-home 按钮应存在').not.toBeNull();
  expect(
    style.main!.weight,
    '「再来一局」应比「返回主界面」更突出（字重）',
  ).toBeGreaterThan(style.back!.weight);
  expect(style.main!.bg, '两个按钮的底色必须不同，否则看不出主次').not.toBe(style.back!.bg);

  await rematch.click();

  /*
   * 新一局的第一帧是**换牌阶段**（开局即停在这里）——
   * 这就是「对局状态完全重置」最直接的证据：换牌只在开局发生。
   */
  await expect(page.getByTestId('mulligan-skip'), '新一局应从换牌阶段开始').toBeVisible({
    timeout: WAIT,
  });
  // 结算覆盖层必须让位（否则新局被上一局的结算压着）
  await expect(page.getByTestId('result-card')).toHaveCount(0);
  await expect(page.getByTestId('game-result')).toHaveCount(0);

  await page.getByTestId('mulligan-skip').click();
  await expect(page.getByTestId('turn')).toContainText('第 1 回合', { timeout: WAIT });
});

test('联机：一方点了只算「请求」，双方都点才开', async ({ browser }) => {
  const { host, guest } = await startGame(browser);
  await concede(host);

  // 双方都在结算页
  await expect(guest.getByTestId('game-result')).toBeVisible({ timeout: WAIT });

  await host.getByTestId('rematch').click();
  // 点过的人：按钮进入等待态并写明原因（否则界面毫无变化，看起来像没点上）
  await expect(host.getByTestId('rematch')).toHaveText('等待对手确认…');
  await expect(host.getByTestId('rematch')).toBeDisabled();
  await expect(host.getByTestId('rematch-wait')).toBeVisible();
  // 另一方要看到「对手想再来一局」，否则他根本不知道有人在等
  await expect(guest.getByTestId('rematch-invite')).toHaveText('对手想再来一局');

  // 新的一局还没开 —— 换牌阶段不该出现
  await expect(host.getByTestId('mulligan-skip')).toHaveCount(0);

  await guest.getByTestId('rematch').click();
  // 双方都进新局
  await expect(host.getByTestId('mulligan-skip'), '主机应进入新一局的换牌').toBeVisible({
    timeout: WAIT,
  });
  await expect(guest.getByTestId('mulligan-skip'), '客人应进入新一局的换牌').toBeVisible({
    timeout: WAIT,
  });
});

test('联机：对手离开后「再来一局」不可点，并说明原因', async ({ browser }) => {
  const { host, guest } = await startGame(browser);
  await concede(host);

  // 对手从结算页回主界面 = 主动离开房间（席位立即释放）
  await guest.getByTestId('back-home').click();
  await expect(guest.getByTestId('create')).toBeVisible({ timeout: WAIT });

  const rematch = host.getByTestId('rematch');
  await expect(rematch, '对手走了，入口仍在（不能凭空消失让人以为界面坏了）').toBeVisible({
    timeout: WAIT,
  });
  await expect(rematch, '没对手可打，按钮必须禁用').toBeDisabled();
  await expect(host.getByTestId('rematch-hint')).toHaveText('对手已离开，无法再来一局');
});
