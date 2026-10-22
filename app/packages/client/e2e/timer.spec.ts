/**
 * 倒计时必须跟着服务端的计时走（issue #155）。
 *
 * ## 问题是什么
 *
 * 顶栏「计时 Ns」只从回合开始那一刻往下数。回合内做任何被接受的操作，秒数都不回弹，
 * 一路数到 `0s` 就停在那里 —— 而操作**仍然被接受**（服务端其实已经把时限续上了）。
 *
 * 根因：`turnDeadline` 只从 `game:snapshot` 读，而「操作被接受」只广播 `room:state`。
 * 服务端的截止时刻一直往后推，客户端手里那个数一直在减 —— 两边说法相反。
 *
 * ## 判据
 *
 * ① 前提：倒计时确实在往下数（否则「回弹」无从谈起）；
 * ② 一次被接受的操作（推进阶段）之后，秒数必须**变大**。
 *
 * 读懂为什么不能「等倒计时掉到 0 再看」：E2E 的回合时限是 120s，等不起；
 * 而「回弹」与「归零后还能操作」是同一个根因的两种表现，前者可测、后者要等两分钟。
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { startSoloGame } from './helpers.js';

const WAIT = Number(process.env.E2E_WAIT_MS ?? 20_000);

/** 读顶栏「计时 Ns」的秒数；读不到返回 NaN（断言自然失败，不用另写分支）。 */
async function clockSeconds(page: Page): Promise<number> {
  const text = (await page.getByTestId('clock').textContent()) ?? '';
  const m = /(\d+)\s*s/.exec(text);
  return m ? Number(m[1]) : Number.NaN;
}

test('回合内被接受的操作会让倒计时回弹（issue #155）', async ({ browser }) => {
  test.setTimeout(150_000);
  const { page } = await startSoloGame(browser);

  /*
   * 人机局的先手可能是 AI（seed 决定，不是固定 p1）。AI 回合里它每动一手都会重新计时
   * —— 时钟被不断刷回满值，看上去「不动」。所以先等到**我方回合**再开始观测。
   */
  await expect(page.getByTestId('turn-label'), 'AI 先手时要先等它把回合交出来').toContainText(
    '你的回合',
    { timeout: 60_000 },
  );

  // 先确认能看到计时（不是「计时 —」）
  await expect(page.getByTestId('clock')).toContainText(/\d+\s*s/, { timeout: WAIT });

  const start = await clockSeconds(page);
  expect(start, '开局应该接近满时限（E2E 环境 120s）').toBeGreaterThan(60);

  // 让秒数真的掉下去 —— 这一步同时是「倒计时在走」的前提断言
  await page.waitForTimeout(4_000);
  const dropped = await clockSeconds(page);
  expect(dropped, '倒计时应该在往下数').toBeLessThan(start - 2);

  // 一次会被接受的操作：推进阶段（六阶段不可跳过，充能 → 重置）
  await page.getByTestId('advance').click();

  /*
   * 给事件抵达 + 播放队列一点时间。计时更新（`game:timer`）是独立的一条轻消息，
   * 到达即回弹，不等动画播完 —— 但那 1~2 秒本身也要从新的时限里扣掉。
   */
  await page.waitForTimeout(1_500);
  const after = await clockSeconds(page);

  expect(
    after,
    `被接受的操作应把计时重新拉回满值：掉到 ${dropped}s 之后做了操作，读到 ${after}s`,
  ).toBeGreaterThan(dropped);
  // 至少回弹 2 秒才算「真的重新计时」，排除只是时钟抖动
  expect(after - dropped, '回弹幅度应明显（重新计时 = 整个时限重来）').toBeGreaterThan(1);
});
