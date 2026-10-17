import { expect, test, type Page } from '@playwright/test';

import {
  activePage,
  advancePhase,
  chargeMinions,
  pick,
  phaseText,
  readHand,
  startGame,
  turnNo,
  zoneCount,
} from './helpers.js';

/**
 * 一个回合的完整操作链路（真界面 + 真服务端）：
 * **充能 → 推进阶段到主要 → 出牌 → 结束回合**。
 *
 * 这是单测覆盖不到的一层：验证「界面发得出 Intent、服务端收得下、
 * 客户端 reduce 得动、UI 反映得出来」这条链路真的闭合。
 *
 * ## 为什么不硬编码「出哪张牌」
 *
 * 起手牌由洗牌决定。断言若绑定具体卡名，改一次卡池就得改一次测试。
 * 故这里**每次都按规则现场推算**该充哪张、该出哪张，只断言
 * **由规则保证的不变量**（费用区 +N、手牌 −1、回合 +1）。
 *
 * ⚠️ 回合时限 30s（ADR-0017）：本用例全程远程操作，若哪天断言开始超时，
 * 先怀疑是不是被超时自动结束回合打断了，而不是规则改了。
 */

test('推进阶段 → 充能 → 出牌 → 结束回合', async ({ browser }) => {
  const { host, guest } = await startGame(browser);
  const pages: readonly Page[] = [host, guest];
  const p = await activePage(pages);

  // ① 开局即处于第一回合的充能阶段（ADR-0016：开局不经过「进入」动作）
  await expect.poll(() => phaseText(p)).toContain('阶段 充能');

  // ② 充能 —— 逐张充能随从（D-112 选中排他：多张充能 = 多次单张操作），
  //    留一张随从准备出牌（X-2：只有随从可充能）
  const chargeCount = await chargeMinions(p);
  expect(await zoneCount(p, 'cost', 1)).toBe(chargeCount);

  // ③ 推进阶段 —— 六阶段不可跳过（A4-2）；重置瞬穿 + 抽牌手动（Era 2026-10-18）：
  //    充能 →（重置瞬穿）→ 抽牌（点卡组）→ 主要
  await advancePhase(p, '抽牌');
  await advancePhase(p, '主要');

  // ④ 出牌 —— 抽牌阶段抽过牌，手牌序号已变，必须重读
  const hand1 = await readHand(p);
  const costZone = await zoneCount(p, 'cost', 1);
  const playable = hand1
    .filter((c) => c.cost <= costZone)
    .sort((a, b) => a.cost - b.cost)[0];
  expect(playable, `费用区 ${costZone} 张，应存在支付得起的手牌`).toBeDefined();
  const pc = playable!;

  const before = hand1.length;
  await pick(p, [pc.index]);
  await p.getByTestId('play').click();

  // 出牌 = 手牌 −1，且落到对应区域（随从进随从区，法术进法术区）
  await expect
    .poll(() => p.getByTestId('hand').locator('[data-testid="card"]').count())
    .toBe(before - 1);

  // ⚠️ B2 上下镜像：对方与我有同名 testid，我方是**后出现的那个**
  if (pc.kind === '随从') {
    await expect(
      p.getByTestId('slot-0').nth(1).locator('[data-testid="card"]'),
    ).toHaveCount(1, { timeout: 10_000 });
  } else {
    await expect.poll(() => zoneCount(p, 'spell', 1)).toBe(1);
  }

  // ⑤ 结束回合 —— 回合数 +1，且行动权移交对手
  //    （事件播放队列节奏让回合切换晚几秒到达，poll 超时放宽到 15s）
  const turn0 = await turnNo(p);
  await p.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(p), { timeout: 15_000 }).toBe(turn0 + 1);
  await expect(p.getByText('对手回合')).toBeVisible({ timeout: 10_000 });
});
