import { expect, test, type Page } from '@playwright/test';

import { activePage, playOneMinion, startGame, turnNo, zoneCount } from './helpers.js';

/**
 * 攻击与战斗结算端到端验证（真界面 + 真服务端）。
 *
 * 覆盖 `attack.ts` 这条**此前从未在联机链路上跑过**的路径：
 * 出随从 → 推进到战斗阶段 → 我方随从攻击对方随从 → 力量值裁决 → 破坏进弃牌区。
 *
 * ## 为什么要跨一个回合
 *
 * A10-3 规定**先攻方第一回合不可攻击**。故流程是：
 * 先攻方出一张随从（当靶子）→ 结束回合 → 后攻方（第 2 回合）出随从 → 战斗阶段发起攻击。
 * 后攻方此时 `turn === 2`，不受该限制约束。
 *
 * ## 断言为什么写「弃牌区总量增加」
 *
 * 裁决结果取决于双方随从的力量值，而力量值取决于抽到什么牌 ——
 * 硬编码「谁死」会把测试和牌序绑死。三种结局（防守方破坏 / 攻击方破坏 / 双方破坏）
 * 都必然让**至少一张卡进弃牌区**，故断言这个不变量。
 *
 * ⚠️ 回合时限 30s（ADR-0017）：本用例要操作两个回合，比 turn.spec.ts 更接近上限。
 * 若断言开始超时，先怀疑被超时自动结束回合打断。
 */

test('出随从 → 战斗阶段发起攻击 → 力量值裁决并结算', async ({ browser }) => {
  // 跨三个回合（先攻首回合 0 充能，首回合可能无牌可出），比单回合用例长。
  test.setTimeout(120_000);

  const { host, guest } = await startGame(browser);
  const pages: readonly Page[] = [host, guest];

  // ① 先攻方首回合（0 充能、maxCost 1）可能无牌可出 —— 直接结束回合
  const first = await activePage(pages);
  const turn0 = await turnNo(first);
  await first.getByTestId('end-turn').click();
  // 事件播放队列（FX 节奏）会让回合切换晚几秒到达客户端 —— poll 超时放宽到 15s
  await expect.poll(() => turnNo(first), { timeout: 15_000 }).toBe(turn0 + 1);

  // ② 后攻方（第 2 回合）出一张随从当靶子，然后结束回合
  const second = await activePage(pages);
  expect(second, '结束回合后应换成另一个玩家行动').not.toBe(first);
  await playOneMinion(second);
  const turn1 = await turnNo(second);
  await second.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(second), { timeout: 15_000 }).toBe(turn1 + 1);

  // ③ 先攻方第 3 回合（maxCost 3）出随从 → 推进到战斗阶段发起攻击
  const attackerPage = await activePage(pages);
  expect(attackerPage).toBe(first);
  await playOneMinion(attackerPage);
  await attackerPage.getByTestId('advance').click();
  await expect.poll(() => attackerPage.locator('header').innerText()).toContain('阶段 战斗');

  // ④ 发起攻击：先点我方随从（选定攻击方），再点对方随从（选定目标）
  //    B2 上下镜像：`slot-0` 出现两次，nth(0) = 对方，nth(1) = 我方
  //
  // 我方弃牌区已与对方**镜像**渲染（Era 2026-10-14），故两侧弃牌区都能观测：
  // `zone-graveyard` 的 nth(0) = 对方（第 ② 排），nth(1) = 我方（第 ⑤ 排）。
  const foeGraveBefore = await zoneCount(attackerPage, 'graveyard', 0);
  const myGraveBefore = await zoneCount(attackerPage, 'graveyard', 1);

  await attackerPage.getByTestId('slot-0').nth(1).locator('[data-testid="card"]').click();

  /*
   * 可攻击目标必须一眼可见（issue #119）。
   *
   * 原实现只给对方目标加了一圈 `ring-emerald-400/80`，而对方随从的卡框本来就是青色 ——
   * 描边微调在深色底上几乎看不出来，玩家点了自己的随从后不知道能打谁，
   * 容易判断成「卡住了」。现在给目标加**角标文字**，并断言它只出现在目标上。
   */
  await expect(
    attackerPage.getByTestId('slot-0').nth(0).locator('[data-testid="hittable-mark"]'),
  ).toBeVisible();
  await expect(
    attackerPage.getByTestId('zone-commander').nth(0).locator('[data-testid="hittable-mark"]'),
  ).toBeVisible();
  // 自己的随从是「攻击方」不是「目标」，不该挂角标（两个概念混在一起就没法区分了）
  await expect(
    attackerPage.getByTestId('slot-0').nth(1).locator('[data-testid="hittable-mark"]'),
  ).toHaveCount(0);

  /*
   * 「取消攻击」与「认输」必须拉开（issue #120）：原来 `gap-1` = 4px，同一行同一高度，
   * 取消一次攻击的手滑就落在认输上。判定用矩形间距，不看样式类名 ——
   * 改成 `justify-between` 也好、加分隔线也好，只要真的分开了就算过。
   */
  const cancelBox = await attackerPage.getByTestId('cancel-attack').boundingBox();
  const concedeBox = await attackerPage.getByTestId('concede').boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(concedeBox).not.toBeNull();
  const sameRow = Math.abs(cancelBox!.y - concedeBox!.y) < 12;
  if (sameRow) {
    const gap = concedeBox!.x - (cancelBox!.x + cancelBox!.width);
    expect(gap, '「取消攻击」与「认输」的水平间距').toBeGreaterThanOrEqual(16);
  }

  await attackerPage.getByTestId('slot-0').nth(0).locator('[data-testid="card"]').click();

  // 战斗结算：至少产出一条「裁决 X vs Y → …」
  await expect(attackerPage.getByTestId('log')).toContainText('裁决', { timeout: 10_000 });

  // 无论哪种结局都必然可见（断言由规则保证的不变量，不依赖抽到哪张牌）：
  //   防守方破坏 → 对方弃牌区 +1；攻击方破坏 → 我方弃牌区 +1；双方破坏 → 两者
  await expect
    .poll(async () => {
      const foeGrave = await zoneCount(attackerPage, 'graveyard', 0);
      const myGrave = await zoneCount(attackerPage, 'graveyard', 1);
      return foeGrave > foeGraveBefore || myGrave > myGraveBefore;
    })
    .toBe(true);

  // 我方弃牌区必须真的渲染出来（此前 B2 原文没给它位置，玩家看不到这一区）
  expect(Number.isFinite(myGraveBefore)).toBe(true);
});

test('攻击对方指挥官 → 对方掉血（ADR-0022）', async ({ browser }) => {
  test.setTimeout(60_000);

  const { host, guest } = await startGame(browser);
  const pages: readonly Page[] = [host, guest];

  // 先攻方**不出牌**直接结束回合 —— 对方场上因此没有随从，
  // 也就不会触发 A7 的「嘲讽必须优先」限制，攻击指挥官这条路才走得通。
  const first = await activePage(pages);
  await first.getByTestId('end-turn').click();
  // 事件播放队列（FX 节奏）会让回合切换晚几秒到达客户端 —— poll 超时放宽到 15s
  await expect.poll(() => turnNo(first), { timeout: 15_000 }).toBe(2);

  const second = await activePage(pages);
  await playOneMinion(second);
  await second.getByTestId('advance').click();
  await expect.poll(() => second.locator('header').innerText()).toContain('阶段 战斗');

  const hpOf = async (): Promise<number> =>
    Number(/(\d+)/.exec((await second.getByTestId('hp-foe').innerText()) ?? '')?.[1] ?? NaN);
  const hpBefore = await hpOf();
  expect(Number.isFinite(hpBefore)).toBe(true);

  // 血量按 Era 2026-10-14 的指定**显示在指挥官区**，不在顶部信息条
  await expect(second.getByTestId('zone-commander').nth(0)).toContainText('血');
  await expect(second.locator('header')).not.toContainText('血');

  // 点我方随从（选定攻击方）→ 点对方**指挥官**（ADR-0022 新接通的入口）
  // `zone-commander` 出现两次：nth(0) = 对方，nth(1) = 我方
  await second.getByTestId('slot-0').nth(1).locator('[data-testid="card"]').click();
  await second.getByTestId('zone-commander').nth(0).locator('[data-testid="card"]').click();

  await expect(second.getByTestId('log')).toContainText('裁决', { timeout: 10_000 });

  // ADR-0014：指挥官不走「破坏」，改为扣血。随从力量值恒 ≥ 1，
  // 而指挥官此时为第 1 档（力量 1），故结局必是「防守方破坏」或「双方破坏」，
  // 两种情况**都会扣血** —— 这个断言不依赖具体抽到哪张牌。
  await expect.poll(hpOf).toBeLessThan(hpBefore);
  await expect(second.getByTestId('log')).toContainText('指挥官受到', { timeout: 10_000 });
});
