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
  // 跨两个回合，比单回合用例长；回合时限 30s 也不允许无限等。
  test.setTimeout(60_000);

  const { host, guest } = await startGame(browser);
  const pages: readonly Page[] = [host, guest];

  // ① 先攻方：出一张随从当靶子，然后结束回合
  const first = await activePage(pages);
  await playOneMinion(first);

  const turn0 = await turnNo(first);
  await first.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(first)).toBe(turn0 + 1);

  // ② 后攻方：出随从 → 推进到战斗阶段
  const second = await activePage(pages);
  expect(second, '结束回合后应换成另一个玩家行动').not.toBe(first);

  await playOneMinion(second);
  await second.getByTestId('advance').click();
  await expect.poll(() => second.locator('header').innerText()).toContain('阶段 战斗');

  // ③ 发起攻击：先点我方随从（选定攻击方），再点对方随从（选定目标）
  //    B2 上下镜像：`slot-0` 出现两次，nth(0) = 对方，nth(1) = 我方
  //
  // ⚠️ 只能观测**双方都可见**的结果：B2 原文的第 ⑤ 排是
  // 「除外 / 费用 / 指挥官 / 法术 / 卡组」，**我方弃牌区根本没有渲染**
  // （对方弃牌区在第 ② 排有）。故我方随从若被破坏，只能看随从区变空。
  const foeGraveBefore = await zoneCount(second, 'graveyard', 0);

  await second.getByTestId('slot-0').nth(1).locator('[data-testid="card"]').click();
  await second.getByTestId('slot-0').nth(0).locator('[data-testid="card"]').click();

  // 战斗结算：至少产出一条「裁决 X vs Y → …」
  await expect(second.getByTestId('log')).toContainText('裁决', { timeout: 10_000 });

  // 无论哪种结局都必然可见：
  //   防守方破坏 → 对方弃牌区 +1；攻击方破坏 → 我方随从区变空；双方破坏 → 两者
  await expect
    .poll(async () => {
      const foeGrave = await zoneCount(second, 'graveyard', 0);
      const myBoard = await second
        .getByTestId('slot-0')
        .nth(1)
        .locator('[data-testid="card"]')
        .count();
      return foeGrave > foeGraveBefore || myBoard === 0;
    })
    .toBe(true);
});

test('攻击对方指挥官 → 对方掉血（ADR-0022）', async ({ browser }) => {
  test.setTimeout(60_000);

  const { host, guest } = await startGame(browser);
  const pages: readonly Page[] = [host, guest];

  // 先攻方**不出牌**直接结束回合 —— 对方场上因此没有随从，
  // 也就不会触发 A7 的「嘲讽必须优先」限制，攻击指挥官这条路才走得通。
  const first = await activePage(pages);
  await first.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(first)).toBe(2);

  const second = await activePage(pages);
  await playOneMinion(second);
  await second.getByTestId('advance').click();
  await expect.poll(() => second.locator('header').innerText()).toContain('阶段 战斗');

  const hpOf = async (): Promise<number> =>
    Number(/(\d+)/.exec((await second.getByTestId('hp-foe').innerText()) ?? '')?.[1] ?? NaN);
  const hpBefore = await hpOf();
  expect(Number.isFinite(hpBefore)).toBe(true);

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
