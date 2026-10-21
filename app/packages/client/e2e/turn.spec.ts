import { expect, test, type Page } from '@playwright/test';

import {
  activePage,
  advancePhase,
  chargeMinions,
  commitPlay,
  costRemaining,
  handCount,
  payOf,
  pick,
  phaseText,
  readHand,
  settleChoices,
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

  // docs/16 §1.3（D-227）：先攻首回合**自动充能 0 张**，且 maxCost = 1，
  // 起手可能一张都打不出（例如 1 张 3 费随从 + 4 张 ≥1 费法术）。
  // 故本用例先让先攻方结束回合，在**后攻方**（起手 6 张 + 充能收入 2 张）身上验证完整操作链。
  const first = await activePage(pages);
  await first.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(first), { timeout: 15_000 }).toBe(2);

  const p = await activePage(pages);
  expect(p, '回合应移交给另一位玩家').not.toBe(first);

  // ① 现在处于第 2 回合的充能阶段
  await expect.poll(() => phaseText(p)).toContain('阶段 充能');

  // ② 充能 —— 逐张充能随从（D-112 选中排他：多张充能 = 多次单张操作），
  //    留一张随从准备出牌（X-2：只有随从可充能）
  const chargeCount = await chargeMinions(p);
  expect(await zoneCount(p, 'cost', 1)).toBe(chargeCount);

  // ③ 推进阶段 —— 六阶段不可跳过（A4-2）；重置瞬穿 + 抽牌手动（Era 2026-10-18）+
  //    抽完自动推进（Era 2026-10-19）：充能 →（重置瞬穿）→ 抽牌（点卡组）→ 自动到主要
  await advancePhase(p, '抽牌');
  await expect.poll(() => phaseText(p)).toContain('阶段 主要');

  // ④ 出牌 —— 抽牌阶段抽过牌，手牌序号已变，必须重读
  const hand1 = await readHand(p);
  const costZone = await zoneCount(p, 'cost', 1);
  const budget = await costRemaining(p);
  const playable = hand1
    .filter((c) => payOf(c) <= costZone && payOf(c) <= budget)
    .sort((a, b) => payOf(a) - payOf(b))[0];
  expect(playable, `费用区 ${costZone} 张、本回合剩余额度 ${budget}，应存在支付得起的手牌`).toBeDefined();
  const pc = playable!;

  const before = hand1.length;
  await pick(p, [pc.index]);
  // D-257：出牌分两段（选位置 / 选费用），统一走 helper，别在这里重写一遍。
  await commitPlay(p);
  // 登场效果可能引出待定选择 —— 放掉，避免卡住后续推进
  await settleChoices(p);

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

/**
 * 先攻第一回合抽 0 张（issue #109 / D-271）。
 *
 * Era 2026-10-21：「先攻开局第一回合不抽牌，不需要展示抽牌按钮，直接自动推进阶段就行了。」
 *
 * 这个阶段**没有决策点**，引擎已改成瞬穿（`advanceOnce` 进 draw 后若该抽 0 张就补
 * `draw:completed` 再继续）。E2E 要钉两件事：
 *  ① 玩家点一次「推进阶段」就落在主要阶段，不会卡在抽牌；
 *  ② 连播放中间帧都不出现「点击抽牌」—— 否则玩家会点到一个服务端早已离开的阶段。
 */
test('先攻第一回合：推进后直接落在主要阶段，全程不出现「点击抽牌」（issue #109）', async ({ browser }) => {
  const { host, guest } = await startGame(browser);
  const p = await activePage([host, guest]);
  expect(await turnNo(p)).toBe(1);
  await expect.poll(() => phaseText(p)).toContain('阶段 充能');

  await p.getByTestId('advance').click();

  // ② 采样整段播放（phase:changed 每条停 750ms，三个阶段约 2s），任何一帧都不该有抽牌按钮
  let sawDrawButton = false;
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if ((await p.getByTestId('draw-deck').count()) > 0) {
      sawDrawButton = true;
      break;
    }
    await p.waitForTimeout(100);
    if ((await phaseText(p)).includes('阶段 主要')) break;
  }
  expect(sawDrawButton, '抽 0 张的抽牌阶段不该给「点击抽牌」').toBe(false);

  // ① 最终停在主要阶段，而不是抽牌阶段
  await expect.poll(() => phaseText(p), { timeout: 10_000 }).toContain('阶段 主要');
  await expect(p.getByTestId('draw-deck')).toHaveCount(0);
});

/**
 * 开局换牌（D-259 / A8-3 / A10-1）。
 *
 * Era 2026-10-21：「开局换牌有这个阶段吗，好像直接开始了啊，换牌这个动作不是在
 * 第一回合做，而是在游戏开始之前做。」
 *
 * 本用例锁三件事：
 *  ① 开局**停在换牌阶段**，回合数还没开始走；
 *  ② **双方各自确认**，只一方确认不关闭阶段（这是「不轮流动手、也不互相卡死」的关键）；
 *  ③ 换牌**不改手牌张数**（先攻补到 5）。
 */
test('开局换牌：独立阶段（游戏开始之前），双方各自确认后才进第一回合（D-259）', async ({ browser }) => {
  const { host, guest } = await startGame(browser, { skipMulligan: false });
  const pages: readonly Page[] = [host, guest];

  // ① 开局即换牌阶段 —— 六个回合阶段一个都没点亮，单独挂一枚「换牌」标签
  for (const p of pages) {
    await expect.poll(() => phaseText(p)).toContain('阶段 换牌');
    await expect(p.getByTestId('phase-track-mulligan')).toBeVisible();
    await expect(p.getByTestId('mulligan-status')).toContainText('等你换牌');
    // 回合还没开始：显示「开局」而不是「第 1 回合」，否则玩家会以为已经在打了
    await expect(p.getByTestId('turn')).toHaveText('开局');
  }

  // ② 认人：起手张数先手 5 / 后手 6（docs/16 §1）。
  //    先等两张页面都发好牌再读，否则会读到「发牌前」的中间态。
  await expect
    .poll(async () => [(await handCount(host)), (await handCount(guest))].sort((a, b) => a - b).join(','), {
      timeout: 15_000,
    })
    .toBe('5,6');
  const first = (await handCount(host)) === 5 ? host : guest;
  const second = first === host ? guest : host;

  // ③ 先攻方换 2 张 → 手牌仍 5 张（A10-1 补满起手），自己进「已确认」
  const cards = first.getByTestId('hand').locator('[data-testid="card"]');
  await cards.nth(0).click();
  await cards.nth(1).click();
  await expect(first.getByTestId('mulligan-confirm')).toContainText('2');
  await first.getByTestId('mulligan-confirm').click();

  // ⚠️ 先等「完成换牌」进日志，再数手牌 —— 否则断言会被换牌前的 5 张满足（D-231 踩过）
  await expect(first.getByTestId('log')).toContainText('完成换牌', { timeout: 15_000 });
  await expect.poll(() => handCount(first), { timeout: 15_000 }).toBe(5);
  await expect(first.getByTestId('mulligan-status')).toContainText('你已确认');
  // 自己确认过 → 按钮组消失（不展示不可用的按钮，Era 2026-10-19）
  await expect(first.getByTestId('mulligan-confirm')).toHaveCount(0);
  await expect(first.getByTestId('mulligan-skip')).toHaveCount(0);

  // ④ **只一方确认不关闭阶段** —— 对方还在换牌，回合不该开始
  await expect.poll(() => phaseText(first), { timeout: 15_000 }).toContain('阶段 换牌');
  await expect(first.getByTestId('turn')).toHaveText('开局');

  // ⑤ 对方点「不换牌」→ 双方都提交 → `mulligan:closed` → 第一回合充能阶段
  await second.getByTestId('mulligan-skip').click();
  await expect.poll(() => phaseText(second), { timeout: 15_000 }).toContain('阶段 充能');
  await expect(second.getByTestId('turn')).toHaveText('第 1 回合');
  await expect(second.getByTestId('phase-track-mulligan')).toHaveCount(0);
  // 行动权落在先攻方身上（先攻方就是上面那位 5 张的）
  await expect(first.getByText('你的回合')).toBeVisible({ timeout: 15_000 });
});

/**
 * 后攻方换牌（D-231）：起手 6 张，换完**仍是 6 张**。
 *
 * 这里把 6 写成字面量、而不是引用 shared 的 `SECOND_PLAYER_HAND` —— 若哪天引擎又把补牌
 * 张数退回 5，本用例必须变红；跟着常量走就只会一起变绿，等于没测。
 *
 * D-259 起换牌是开局前的独立阶段，双方同时进行，**不用等先攻方结束回合**（X-17 已废弃）。
 */
test('后攻方换牌：起手 6 张，换 2 张后仍补到 6 张（D-231 / D-259）', async ({ browser }) => {
  const { host, guest } = await startGame(browser, { skipMulligan: false });

  // ① 后攻方 = 起手 6 张的那一位
  await expect
    .poll(async () => [(await handCount(host)), (await handCount(guest))].sort((a, b) => a - b).join(','), {
      timeout: 15_000,
    })
    .toBe('5,6');
  const second = (await handCount(host)) === 6 ? host : guest;

  // ② 同时换 —— 不等谁先动
  await expect.poll(() => phaseText(second)).toContain('阶段 换牌');
  const cards = second.getByTestId('hand').locator('[data-testid="card"]');
  await cards.nth(0).click();
  await cards.nth(1).click();
  await expect(second.getByTestId('mulligan-confirm')).toContainText('2');
  await second.getByTestId('mulligan-confirm').click();

  // ③ 换牌不改手牌数：仍是 6 张（D-231 的不变量 —— 修之前这里会掉到 5）
  //
  // ⚠️ 顺序很重要：先等「完成换牌」进日志（证明服务端真收了这次换牌并回了事件），
  // 再数手牌。否则断言会在事件到达之前就被「换牌前的 6 张」满足 —— 拿坏代码跑也绿。
  await expect(second.getByTestId('log')).toContainText('完成换牌', { timeout: 15_000 });
  await expect.poll(() => handCount(second), { timeout: 15_000 }).toBe(6);
  await expect(second.getByTestId('mulligan-confirm')).toHaveCount(0);
});
