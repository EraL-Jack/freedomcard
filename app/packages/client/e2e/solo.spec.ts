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

/**
 * D-267 / issue #99：换牌阶段的倒计时必须**可见**。
 *
 * 原来 `snapshot.turnDeadline` 取的是回合计时器的截止时刻，而换牌阶段那个计时器是
 * `clear` 状态（值 0）→ 顶栏「计时 —」。Era 的原话：「倒计时要显示在桌面上，
 * 目前看倒计时是 -」。这条钉两件事：数字要出来，且要说明「到点会自动开局」。
 *
 * ⚠️ 只断言「不是 —」是不够的：`remain` 为 0 时也会显示 `0s`。
 * 所以正则要求 ≥1 位数字且带 `s`，并在文案里确认「到点自动不换牌」——
 * 后者是玩家得知「我可以什么都不点」的唯一途径。
 */
test('换牌阶段桌面有倒计时，并写明到点自动开局（D-267）', async ({ browser }) => {
  const { page } = await startSoloGame(browser, { skipMulligan: false });

  await expect(page.getByTestId('clock'), '换牌阶段顶栏应显示剩余秒数').toHaveText(/计时 \d+s/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('phase-hint')).toContainText('剩余');
  await expect(page.getByTestId('phase-hint')).toContainText('到点自动不换牌开局');
});

/**
 * D-268 / issue #101：**回合边界的中间帧不许被当成真局面**。
 *
 * Era 的原话：「充能阶段的提示在切换回合之前显示了」。
 *
 * 根因不在引擎 —— 回合边界在事件流里就是两条（`phase:changed(… → charge)` +
 * `turn:changed`），是客户端**逐条播放 + 每相位停 750ms** 把中间那一帧画了出来：
 * 阶段已经是下一回合的充能、`activeSeat` 还是自己，于是结束回合的人看到
 * 「你的回合 · 充能阶段：点手牌里的随从…」，愣一下才交棒给对手。
 *
 * ## 为什么这样断言
 *
 * 单点断言会漏：坏状态下只有 750ms 是错的，`toHaveText` 可能正好错过，好状态下
 * 也不该依赖时序。所以这里**连续采样**整个交棒过程，只钉一条不变量：
 * 任何一帧都不得同时出现「你的回合」与「充能阶段」的指引 ——
 * 这个组合从未真实存在过。坏代码必然在窗口内被采到，好代码一帧都不违例。
 */
test('结束回合时不给「你的回合 + 充能阶段」的错误指引（D-268）', async ({ browser }) => {
  const { page } = await startSoloGame(browser);

  // 先后手由 seed 决定，不能假设玩家先手 —— 等到真的轮到我再动手
  await expect(page.getByTestId('turn-label'), '应轮到玩家行动').toHaveText('你的回合', {
    timeout: 15_000,
  });

  const sample = (): Promise<{ label: string; phase: string; hint: string }> =>
    page.evaluate(() => {
      const text = (id: string): string =>
        document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
      return { label: text('turn-label'), phase: text('phase'), hint: text('phase-hint') };
    });

  await expect(page.getByTestId('phase'), '开局应停在充能阶段').toContainText('充能');
  await page.getByTestId('end-turn').click();

  const samples: { label: string; phase: string; hint: string }[] = [];
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    const s = await sample();
    samples.push(s);
    // 交棒完成即停止 —— 再往后「真的是我」的充能阶段不算违例
    if (s.label === '对手回合') break;
    await page.waitForTimeout(40);
  }

  // ① 交棒必须真的发生过，否则后面的断言是空验证
  expect(
    samples.at(-1)?.label,
    `回合应已交给电脑，实际采样：${JSON.stringify(samples.slice(-3))}`,
  ).toBe('对手回合');

  /*
   * ② 先定位「阶段第一次离开充能、又回到充能」的那一帧 —— 那是新回合的起点。
   *
   * ⚠️ 不能只断言「不得同时出现 你的回合 + 充能阶段」：**我自己的充能阶段本来就是
   * 这个组合**（合法的回合起点），照字面断言会把正确行为判成错误（首版就是这么翻的车）。
   * 违例只在「离开过充能之后又回到充能、席位却还没换」时成立 —— 那个局面从未真实存在。
   */
  const leftCharge = samples.findIndex((s) => !s.phase.includes('充能'));
  expect(leftCharge, '应观察到阶段离开充能（战斗 / 结束阶段）').toBeGreaterThan(-1);
  const backToCharge = samples.findIndex((s, i) => i > leftCharge && s.phase.includes('充能'));
  expect(backToCharge, '应观察到阶段回到充能（新回合起点）').toBeGreaterThan(-1);

  const lies = samples
    .slice(backToCharge)
    .filter((s) => s.label === '你的回合' && s.hint.includes('充能阶段'));
  expect(lies, '交棒前的那 750ms 不应给出「你的回合 · 充能阶段」的指引').toEqual([]);
});
