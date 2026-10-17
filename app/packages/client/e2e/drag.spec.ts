import { expect, test, type Page } from '@playwright/test';

import { activePage, advancePhase, chargeMinions, playOneMinion, readHand, startGame, turnNo, zoneCount } from './helpers.js';

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
  test.setTimeout(60_000);
  const { host, guest } = await startGame(browser);
  const p = await activePage([host, guest]);

  // ① 充能阶段：拖一张随从到**我方费用区**（zone-cost nth(1)，B2 镜像）
  await expect.poll(() => phaseOf(p)).toContain('阶段 充能');
  const hand0 = await readHand(p);
  const minion = hand0.filter((c) => c.kind === '随从')[0];
  expect(minion, '起手应有可充能的随从').toBeDefined();
  const costBefore = await zoneCount(p, 'cost', 1);

  await dragTo(
    p,
    p.getByTestId('hand').locator('[data-testid="card"]').nth(minion!.index),
    p.getByTestId('zone-cost').nth(1),
  );
  await expect.poll(() => zoneCount(p, 'cost', 1)).toBe(costBefore + 1);

  // ② 推进到主要阶段（重置瞬穿 + 点卡组抽牌），再拖一张支付得起的手牌到随从区
  await chargeMinions(p); // 继续充能凑费用（逐张，排他选中兼容）
  await advancePhase(p, '抽牌');
  await advancePhase(p, '主要');

  const hand1 = await readHand(p);
  const costZone = await zoneCount(p, 'cost', 1);
  const chosen = hand1
    .filter((c) => c.kind === '随从')
    .filter((c) => c.cost <= costZone)
    .sort((a, b) => a.cost - b.cost)[0];
  expect(chosen, `费用区 ${costZone} 张，应存在支付得起的随从`).toBeDefined();

  const handBefore = hand1.length;
  await dragTo(
    p,
    p.getByTestId('hand').locator('[data-testid="card"]').nth(chosen!.index),
    p.getByTestId('slot-0').nth(1), // 我方随从区第 1 格（B2 镜像 nth(1)）
  );
  await expect
    .poll(() => p.getByTestId('hand').locator('[data-testid="card"]').count())
    .toBe(handBefore - 1);
  await expect(p.getByTestId('slot-0').nth(1).locator('[data-testid="card"]')).toHaveCount(1, {
    timeout: 10_000,
  });
});

test('拖拽我方随从到对方随从 = 发起攻击', async ({ browser }) => {
  test.setTimeout(90_000);
  const { host, guest } = await startGame(browser);
  const pages: readonly Page[] = [host, guest];

  // 先攻方出一张随从当靶子后结束回合
  const first = await activePage(pages);
  await playOneMinion(first);
  const turn0 = await turnNo(first);
  await first.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(first), { timeout: 15_000 }).toBe(turn0 + 1);

  // 后攻方出随从 → 推进到战斗阶段 → 拖拽攻击
  const second = await activePage(pages);
  await playOneMinion(second);
  await advancePhase(second, '战斗');

  const foeGraveBefore = await zoneCount(second, 'graveyard', 0);
  const myGraveBefore = await zoneCount(second, 'graveyard', 1);

  await dragTo(
    second,
    second.getByTestId('slot-0').nth(1).locator('[data-testid="card"]'),
    second.getByTestId('slot-0').nth(0).locator('[data-testid="card"]'),
  );

  await expect(second.getByTestId('log')).toContainText('裁决', { timeout: 10_000 });
  await expect
    .poll(async () => {
      const foeGrave = await zoneCount(second, 'graveyard', 0);
      const myGrave = await zoneCount(second, 'graveyard', 1);
      return foeGrave > foeGraveBefore || myGrave > myGraveBefore;
    })
    .toBe(true);
});

/** header 文本（含阶段名）—— 与 helpers.phaseText 同口径。 */
async function phaseOf(page: Page): Promise<string> {
  return ((await page.locator('header').innerText()) ?? '').trim();
}
