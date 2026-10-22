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

/**
 * #143 / `docs/16 §7.5.2`（Era 2026-10-22 拍板 C-06）：
 *
 * > 「隐藏区的牌对对手隐藏，公开区的牌对对手公开，**能量区属于公开区**」
 * > 「对手有权查看你费用区里的具体卡牌，不是只知道张数」
 *
 * #142 只做了「藏」那一半（充能战报不念卡名），桌面这半没人验证过。
 * 这条用例钉的是**信息对对手可得**：点开对手费用区能看到卡面，且张数与区域一致。
 *
 * 只管「可得」，不管呈现 —— B2-3 规定区域格子默认只显示「区名 + 张数」，
 * 点开看浮窗，这本身不违反规则（§7.5.2 的注释就是这么写的）。
 */
test('对手费用区可点开查看具体卡牌（#143）', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page } = await startSoloGame(browser);

  /*
   * 等电脑的费用区长起来：每回合强制收入 2 张（`COST_INCOME_PER_TURN`），
   * AI 现在还会主动把手牌充能（#137），所以这一格必然会非空。
   * 轮询里顺手把自己的回合交出去，否则电脑不会动。
   */
  const waited = await expect
    .poll(
      async () => {
        const n = await zoneCount(page, 'cost', 0);
        if (n > 0) return n;
        const label = (await page.getByTestId('turn-label').innerText().catch(() => '')).trim();
        if (label === '你的回合') {
          await page.getByTestId('end-turn').click({ timeout: 5_000 }).catch(() => {});
        }
        return 0;
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0)
    .then(() => true)
    .catch(() => false);

  const foeCost = await zoneCount(page, 'cost', 0);
  expect(waited, `电脑费用区应长出牌来（实测 ${foeCost} 张）`).toBe(true);

  // 未点开时：框里不铺卡，只有「区名 + 张数」（B2-3）
  const box = page.getByTestId('zone-cost').nth(0);
  await expect(box.getByTestId('card')).toHaveCount(0);

  // 点开 → 浮窗里能看到**全部**卡，张数与费用区一致
  await box.click();
  const float = page.getByTestId('zone-float');
  await expect(float).toBeVisible({ timeout: 10_000 });
  await expect(float.getByTestId('card')).toHaveCount(foeCost);

  // 关键：卡面不是空壳 —— 每张都能读出非空文本（牌名 / 费用 / 力量）
  const texts = await float.getByTestId('card').allInnerTexts();
  expect(texts.length, '浮窗里应有卡').toBe(foeCost);
  for (const t of texts) {
    expect(t.trim().length, `对手费用区的卡面应可读，实测：${JSON.stringify(texts)}`).toBeGreaterThan(0);
  }

  await page.getByTestId('zone-float-close').click();
  await expect(float).toBeHidden();
});
