/**
 * 操作在途必须有反馈（issue #158）。
 *
 * ## 现象
 *
 * 点一次「推进阶段」，界面约 1.5~2 秒没有任何变化（顶栏还写着「阶段 充能」、
 * 按钮外观也不变），随后才跳。期间连点第二下，会基于客户端还没 reduce 的旧状态发出、
 * 被阶段规则拒掉 —— 而那条拒绝提示常被下一条盖掉，玩家只看到「点了没反应」。
 *
 * ## 为什么慢的是「播放」不是「网络」
 *
 * 服务端 100ms 内就回了。慢在客户端**逐条播放**事件（`FX_MS`，Era 明确要的节奏）。
 * 所以「在途」必须一直持续到播放队列排空 —— 那才是界面真正翻页的时刻。
 *
 * ## 判据
 *
 * ① 点下之后 **3 秒内**顶栏出现「同步中…」（这条不依赖某个按钮是否还活着）；
 * ② 在途期间动作按钮 `disabled`（否则第二下会撞规则）；
 * ③ 播完自动消失 —— 卡在「处理中」比没有提示更糟。
 *
 * ⚠️ 与 `feedback.spec.ts` 分工：那边是「提示要落在首屏内」（D-256），
 * 这边是「我这一手正在被处理」。两者都不是「有没有提示」这么泛的命题。
 */

import { expect, test } from '@playwright/test';

import { startSoloGame } from './helpers.js';

const WAIT = Number(process.env.E2E_WAIT_MS ?? 20_000);

test('推进阶段后立刻有「处理中」反馈，播完自动恢复（#158）', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await startSoloGame(browser);

  // 人机局的先手可能是 AI —— 先等到我方回合，否则点不到按钮
  await expect(page.getByTestId('turn-label')).toContainText('你的回合', { timeout: 60_000 });

  await page.getByTestId('advance').click();

  const syncing = page.getByTestId('syncing');
  await expect(syncing, '发出操作后必须立刻有「我在处理」的迹象').toBeVisible({ timeout: 3_000 });

  /*
   * 在途期间按钮不可点。阶段推进后按钮可能被换掉（`phase === 'draw'` 时不存在），
   * 所以先判存在再判 disabled —— 不存在的按钮谈不上「能不能点」。
   */
  const advance = page.getByTestId('advance');
  if ((await advance.count()) > 0) {
    await expect(advance, '在途期间按钮必须禁用，连点会被服务端拒掉').toBeDisabled();
  }

  await expect(syncing, '播放队列排空后必须复位，不能永远停在同步中').toHaveCount(0, {
    timeout: WAIT,
  });
});
