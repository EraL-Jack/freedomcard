import { expect, test, type Page } from '@playwright/test';

import { activePage, advancePhase, chargeMinions, confirmPay, costRemaining, payOf, playOneMinion, readHand, settleChoices, startGame, turnNo, zoneCount, type HandCard } from './helpers.js';

/**
 * 拖拽交互端到端验证（B3-1「点选+拖拽都要」/ Era 2026-10-18「模拟现实操作的卡牌」）。
 *
 * 拖拽用 pointer events 实现（移动端单指兼容，B5-3）；
 * 拖回原位或无效区域 = 取消（B3-4，本文件不断言取消路径，点击语义已由 turn/combat 覆盖）。
 */

/** 用鼠标把 `from` 元素拖到 `to` 元素中心（慢速多步移动，确保越过拖拽阈值）。 */
async function dragTo(page: Page, from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>): Promise<void> {
  const fb = await from.boundingBox();
  const tb = await to.boundingBox();
  expect(fb, '拖拽源应可见').toBeTruthy();
  expect(tb, '拖拽目标应可见').toBeTruthy();
  await page.mouse.move(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);
  await page.mouse.down();
  await page.mouse.move(tb!.x + tb!.width / 2, tb!.y + tb!.height / 2, { steps: 12 });
  await page.mouse.up();
}

test('拖拽手牌到费用区 = 充能；拖拽手牌到随从区 = 出牌', async ({ browser }) => {
  test.setTimeout(90_000);
  const { host, guest } = await startGame(browser);
  const pages = [host, guest];

  // docs/16 §1.3（D-227）：先攻首回合 0 充能、maxCost 1，起手可能无牌可出。
  // 换到后攻方（6 张起手 + 充能收入 2）验证拖拽链路。
  const first = await activePage(pages);
  const turn0 = await turnNo(first);
  await first.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(first), { timeout: 15_000 }).toBe(turn0 + 1);

  const p = await activePage(pages);

  // ① 充能阶段：拖一张随从到**我方费用区**（zone-cost nth(1)，B2 镜像）
  await expect.poll(() => phaseOf(p)).toContain('阶段 充能');
  // ⚠️ 拖拽标记只在「可操作」时才挂（与置灰同一份判定）；播放队列未播完时标记未渲染，
  //   必须等标记出现再拖，否则 pointerdown 找不到拖拽源 = 静默无效（全量并发下偶发超时的根因）。
  await expect
    .poll(() => p.getByTestId('hand').locator('[data-drag-uid]').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const hand0 = await readHand(p);
  const minion = hand0.filter((c) => c.kind === '随从')[0];
  expect(minion, '起手应有可充能的随从').toBeDefined();
  const costBefore = await zoneCount(p, 'cost', 1);

  await dragTo(
    p,
    p.getByTestId('hand').locator('[data-testid="card"]').nth(minion!.index),
    p.getByTestId('zone-cost').nth(1),
  );
  await expect.poll(() => zoneCount(p, 'cost', 1)).toBeGreaterThan(costBefore);

  // ② 推进到主要阶段（重置瞬穿 + 点卡组抽牌 + 抽完自动推进，Era 2026-10-19），
  //    再拖一张支付得起的手牌到随从区
  await chargeMinions(p); // 继续充能凑费用（逐张，排他选中兼容）
  await advancePhase(p, '抽牌'); // 抽完自动落在主要阶段（helper 内断言）

  const hand1 = await readHand(p);
  const costZone = await zoneCount(p, 'cost', 1);
  const budget = await costRemaining(p);
  const chosen = hand1
    .filter((c) => c.kind === '随从')
    .filter((c) => payOf(c) <= costZone && payOf(c) <= budget)
    .sort((a, b) => payOf(a) - payOf(b))[0];
  expect(chosen, `费用区 ${costZone} 张、本回合剩余额度 ${budget}，应存在支付得起的随从`).toBeDefined();

  const handBefore = hand1.length;
  await dragTo(
    p,
    p.getByTestId('hand').locator('[data-testid="card"]').nth(chosen!.index),
    p.getByTestId('slot-0').nth(1), // 我方随从区第 1 格（B2 镜像 nth(1)）
  );
  // D-257：拖到格子 = 选好位置，但「付哪几张」仍要确认一次（费用区通常比该付的多）
  await confirmPay(p);
  await expect
    .poll(() => p.getByTestId('hand').locator('[data-testid="card"]').count())
    .toBe(handBefore - 1);
  await expect(p.getByTestId('slot-0').nth(1).locator('[data-testid="card"]')).toHaveCount(1, {
    timeout: 10_000,
  });
  await settleChoices(p);
});

test('拖拽我方随从到对方随从 = 发起攻击', async ({ browser }) => {
  test.setTimeout(120_000);
  const { host, guest } = await startGame(browser);
  const pages: readonly Page[] = [host, guest];

  // 先攻方首回合（0 充能、maxCost 1）可能无牌可出 —— 结束回合；
  // 后攻方出随从当靶子，再结束回合；先攻方第 3 回合（maxCost 3）出随从并拖拽攻击。
  const first = await activePage(pages);
  const turn0 = await turnNo(first);
  await first.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(first), { timeout: 15_000 }).toBe(turn0 + 1);

  const second = await activePage(pages);
  expect(second).not.toBe(first);
  await playOneMinion(second);
  const turn1 = await turnNo(second);
  await second.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(second), { timeout: 15_000 }).toBe(turn1 + 1);

  const third = await activePage(pages);
  expect(third).toBe(first);
  await playOneMinion(third);
  await advancePhase(third, '战斗');
  // 等拖拽标记挂上（战斗阶段 + 未休眠 → minionOperable 才渲染 data-drag-uid）。
  // ⚠️ 标记在格子**自身**（BoardSlot 根元素），不是后代 —— 必须用属性交集选择器，
  //   写成 `.locator('[data-drag-uid]')` 会永远数到 0（2026-10-18 实测）。
  await expect
    .poll(() => third.locator('[data-testid="slot-0"][data-drag-uid]').count(), { timeout: 15_000 })
    .toBe(1);

  const foeGraveBefore = await zoneCount(third, 'graveyard', 0);
  const myGraveBefore = await zoneCount(third, 'graveyard', 1);

  await dragTo(
    third,
    third.getByTestId('slot-0').nth(1).locator('[data-testid="card"]'),
    third.getByTestId('slot-0').nth(0).locator('[data-testid="card"]'),
  );

  await expect(third.getByTestId('log')).toContainText('裁决', { timeout: 10_000 });
  await expect
    .poll(async () => {
      const foeGrave = await zoneCount(third, 'graveyard', 0);
      const myGrave = await zoneCount(third, 'graveyard', 1);
      return foeGrave > foeGraveBefore || myGrave > myGraveBefore;
    })
    .toBe(true);
});

/**
 * 法术拖到法术区（issue #108 / D-272）。
 *
 * Era 2026-10-21：「拖动释放法术卡时，应该可以放到法术区，目前只能拖动到随从区而且放不出来。」
 *
 * 修之前法术**只能**用「出牌」按钮出；拖拽这条入口是给随从做的，
 * 法术区没有落点、拖到随从格又必然带一个非法 slot。
 */
test('拖拽法术卡到法术区 = 出牌（issue #108）', async ({ browser }) => {
  // 150s：可能要为「手上没有付得起的法术」推进若干回合（issue #149），比原来的 90s 留出余量
  test.setTimeout(150_000);
  const { host, guest } = await startGame(browser);
  const pages = [host, guest];

  // 先攻首回合 0 充能、maxCost 1 —— 换到后攻方（6 张起手 + 充能收入 2 张）
  const first = await activePage(pages);
  const turn0 = await turnNo(first);
  await first.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(first), { timeout: 15_000 }).toBe(turn0 + 1);

  const p = await activePage(pages);
  await expect.poll(() => phaseOf(p)).toContain('阶段 充能');

  // 手牌与抽牌都是随机的，可能一张付得起的法术都没有（见 `ensureSpellToCast`）——
  // 它在必要时自动推进回合、靠抽牌凑出可打的法术，而不是碰运气。
  const spell = await ensureSpellToCast(pages, p);
  const hand = await readHand(p);

  const before = hand.length;
  const spellZoneBefore = await zoneCount(p, 'spell', 1);
  const graveBefore = await zoneCount(p, 'graveyard', 1);

  // 拖到**我方法术区**（B2 镜像：我方是后出现的那个，nth(1)）
  await dragTo(
    p,
    p.getByTestId('hand').locator('[data-testid="card"]').nth(spell!.index),
    p.getByTestId('zone-spell').nth(1),
  );
  await confirmPay(p); // 费用区比该付的多时会弹支付面板

  await expect
    .poll(() => p.getByTestId('hand').locator('[data-testid="card"]').count(), { timeout: 10_000 })
    .toBe(before - 1);
  // 普通法术结算后进弃牌区、设置法术留在法术区 —— 两者任一增加即说明牌真的出去了
  await expect
    .poll(async () => {
      const spellZone = await zoneCount(p, 'spell', 1);
      const grave = await zoneCount(p, 'graveyard', 1);
      return spellZone > spellZoneBefore || grave > graveBefore;
    })
    .toBe(true);
  await expect(p.getByText('只有随从需要指定位置')).toHaveCount(0);
});

/**
 * 推进到「手牌里存在付得起的法术」为止（issue #149）。
 *
 * ## 为什么不能读一次手牌就断言
 *
 * 起手与抽牌都是随机的，而**法术不吃随从减费**（`MINION_COST_DISCOUNT` 只作用于随从），
 * 后攻首回合的额度又只有 1~3 —— 手里有没有「≤ 额度」的法术完全看牌序。
 * 更难受的是反方向也会踩：`chargeMinions` 会把随从全充进费用区，
 * 若起手 6 张全是随从，手上连一张法术都不剩，再怎么充也变不出来。
 * 炎刃卡组 30 张里只有 7 张非随从，起手全随从约 **17%** —— 旧写法在这种牌型下
 * **必然**红，而失败信息是「手牌里应有付得起的法术」，读起来像实现坏了。
 * 它已经误伤过一次：D-290 的全量跑出现 1 红，最后要靠人工复跑 3 次才能排除。
 *
 * ## 为什么是「推进回合」而不是 issue 里的另外两个选项
 *
 * - 传 seed：`room:create` 要新增可选字段，schema / 服务端 / 回放三处跟着改，为一条用例动协议不值；
 * - 「拖任意付得起的牌」：法术区只收法术，拖随从会被拒，验不到目标路径。
 *
 * 牌库固定含 7 张法术，所以**抽牌是唯一确定性能拿到法术的途径**。
 * 每圈：充能（不留随从，把 `maxCost` 档位抬上去）→ 抽牌 → 看手牌；没有就结束回合。
 * 10 圈内抽到至少一张法术的概率 96%（`1 - C(23,10)/C(30,10)`），够用；
 * 真跑满 10 圈说明牌库构成变了，那是该被发现的新事实，不是该被咽下去的偶发。
 */
async function ensureSpellToCast(pages: readonly Page[], me: Page): Promise<HandCard> {
  for (let round = 0; round < 10; round++) {
    // 轮到对手就替它结束回合 —— E2E 里没有 AI，另一个页面就是对手本人。
    for (let guard = 0; guard < 4; guard++) {
      const actor = await activePage(pages);
      if (actor === me) break;
      const t = await turnNo(actor);
      await actor.getByTestId('end-turn').click();
      await expect.poll(() => turnNo(actor), { timeout: 15_000 }).toBeGreaterThan(t);
    }

    // 法术用例不需要留随从：全充进费用区，`maxCost` 按 chargeCount 分档抬上去。
    await expect.poll(() => phaseOf(me), { timeout: 15_000 }).toContain('阶段 充能');
    await chargeMinions(me, 0);
    await advancePhase(me, '抽牌'); // 抽完自动落在主要阶段

    const hand = await readHand(me);
    const costZone = await zoneCount(me, 'cost', 1);
    const budget = await costRemaining(me);
    const spell = hand
      .filter((c) => c.kind === '法术' || c.kind === '设置')
      .filter((c) => payOf(c) <= costZone && payOf(c) <= budget)
      .sort((a, b) => payOf(a) - payOf(b))[0];
    if (spell) return spell;

    // 本回合没有能用的法术 —— 结束回合，靠下一张抽牌
    const t = await turnNo(me);
    await me.getByTestId('end-turn').click();
    await expect.poll(() => turnNo(me), { timeout: 15_000 }).toBeGreaterThan(t);
  }
  throw new Error('推进 10 个回合仍没有付得起的法术 —— 牌库构成变了？');
}

/** header 文本（含阶段名）—— 与 helpers.phaseText 同口径。 */
async function phaseOf(page: Page): Promise<string> {
  return ((await page.locator('header').innerText()) ?? '').trim();
}
