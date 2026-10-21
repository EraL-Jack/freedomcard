import { expect, test } from '@playwright/test';

import { chargeMinions, startSoloGame, zoneCount } from './helpers.js';

/**
 * D-265（Era 2026-10-21）：
 *
 * > 用浮窗显示堆叠区内容，而不是直接在牌桌上显示，你牌桌怎么都塞不下这么多卡吧
 *
 * 原来的「展开」是在**区域框里**把卡 flex-wrap 铺开 —— 弃牌区到 15 张、费用区到 10 张时
 * 那一格根本放不下，只会被 `overflow-hidden` 裁掉，玩家既看不全、又把区域挤变形。
 * 现在区域框恒只显示「区名 + 张数」，内容进浮窗看。
 *
 * 两条契约分开断言，避免混在一起后互相掩盖：
 *   ① 点开 → 浮窗里能看到全部卡，**牌桌上不铺卡**；
 *   ② 卡组区**不可查看** —— 卡组顺序是隐藏信息（能看到下一步抽什么就破坏了对战公平）。
 */
test('D-265 堆叠区点开走浮窗，牌桌上不铺卡', async ({ browser }) => {
  test.setTimeout(90_000);
  const { page } = await startSoloGame(browser);

  // 等到我方充能阶段并充能 —— 费用区因此必然有牌（不依赖抽牌运气）
  await expect
    .poll(async () => (await page.locator('header').innerText()).includes('充能'), { timeout: 30_000 })
    .toBe(true);
  await chargeMinions(page);

  const cost = await zoneCount(page, 'cost', 1);
  expect(cost, '充能后我方费用区应当有牌').toBeGreaterThan(0);

  // ① 未点开时：框内不铺卡（只有区名与张数）
  await expect(page.getByTestId('zone-cost').nth(1).getByTestId('card')).toHaveCount(0);

  // ② 点开：浮窗出现，且浮窗内张数与费用区一致
  await page.getByTestId('zone-cost').nth(1).click();
  const float = page.getByTestId('zone-float');
  await expect(float).toBeVisible({ timeout: 10_000 });
  await expect(float.getByTestId('card')).toHaveCount(cost);

  // ③ 关键契约：牌桌上**仍然**不铺卡 —— 内容只在浮窗里
  await expect(page.getByTestId('zone-cost').nth(1).getByTestId('card')).toHaveCount(0);

  // ④ 关掉浮窗后回到牌桌
  await page.getByTestId('zone-float-close').click();
  await expect(float).toBeHidden();
});

test('D-265 卡组区不可查看内容（卡组顺序是隐藏信息）', async ({ browser }) => {
  const { page } = await startSoloGame(browser);

  const foeDeck = page.getByTestId('zone-deck').nth(0);
  await expect(foeDeck).toBeVisible({ timeout: 10_000 });

  // 点标题行（区域顶部）—— 这是原来唯一能「展开」的入口，必须点这里才算真的试图打探。
  await foeDeck.click({ position: { x: 12, y: 6 } });

  // 不弹浮窗，也不在框里铺卡 —— 只保留张数
  await expect(page.getByTestId('zone-float')).toBeHidden();
  await expect(foeDeck.getByTestId('card')).toHaveCount(0);
});
