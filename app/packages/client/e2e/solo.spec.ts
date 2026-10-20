/**
 * 人机对战（D-242，Era 2026-10-21）—— 「不用开两个窗口」。
 *
 * 一条用例覆盖三件事：
 * 1. 建房即坐入「电脑」，房间直接满员（capacity 被服务端收到 2）；
 * 2. 玩家点准备就能开局（AI 永远就绪，不必等一个不会点按钮的对手）；
 * 3. 电脑会自己行动 —— 日志里出现它的动作，且不会卡住。
 *
 * 不断言「AI 打得聪明」，那是 `core/src/ai.test.ts` 的职责（纯函数、可精确摆局面）。
 * E2E 只证明整条链路是活的：服务端调度 → 系统 Intent → 事件广播 → 客户端渲染。
 */

import { expect, test } from '@playwright/test';

import { newClient } from './helpers.js';

test('人机对战：建房坐入电脑、准备即开局、电脑自己行动', async ({ browser }) => {
  const page = await newClient(browser, 'Era');

  await page.getByTestId('create-solo').click();

  // ① 席位里立刻有「电脑」，且房间是 2 人（服务端强制，不受人数输入影响）
  await expect(page.getByTestId('seats')).toContainText('电脑', { timeout: 20_000 });
  await expect(page.getByText('2/2 人')).toBeVisible({ timeout: 20_000 });

  // ② 只点自己的准备就开局 —— AI 的 ready 是服务端代设的
  await page.getByTestId('ready').click();
  await expect(page.getByTestId('turn')).toBeVisible({ timeout: 20_000 });

  // ③ 电脑自己动过手：日志里出现它的名字（洗牌 / 抽牌 / 充能 / 出牌都会带玩家名）
  await expect(page.getByTestId('log')).toContainText('电脑', { timeout: 40_000 });

  // ④ 对局没有卡死：回合数会推进（AI 打完自己那一回合后交还给玩家）
  await expect
    .poll(async () => Number((await page.getByTestId('turn').textContent())?.replace(/\D/g, '') ?? 0), {
      timeout: 60_000,
    })
    .toBeGreaterThan(1);
});
