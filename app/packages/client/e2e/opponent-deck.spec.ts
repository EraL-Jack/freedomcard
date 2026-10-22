/**
 * 人机房可选对手卡组（#161 / D-314）。
 *
 * Era 2026-10-22 17:41 拍板「161人机可选」→ 排进第一版。定稿的三条边界：
 *  ① 可选范围 = `BASIC_DECKS` 那三套（不新造）；
 *  ② **不指定 = 维持现状**（按房间码散列，同房码同对手）；
 *  ③ 只影响人机，联机建房没有这一项。
 *
 * 断言读的是**对手指挥官区的文案**：它是「选哪一套」唯一能被玩家看见的结果。
 * 不去读请求体 —— 那要另开 socket 拦截，而这条链路的真问题是
 * 「字段有没有穿过 zod 到房间层」，单测 `schema.test.ts` + `room.test.ts` 已经覆盖，
 * 这里补的是「从界面一路到桌面」这一段。
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { newClient } from './helpers.js';

/** 与其它 spec 同款：本地 15s，公网验证时由 `E2E_WAIT_MS` 放宽。 */
const WAIT = Number(process.env.E2E_WAIT_MS ?? 15_000);

/** 三套基础卡组的指挥官 —— 与 `cards.ts` 的 `name` 一致。 */
const COMMANDERS = {
  blade: '炎刃军统领',
  frost: '霜律裁决官',
  star: '星轨观测者',
} as const;

/** 按钮文案里的短名 —— `default-decks.ts` 的 `name` 是「炎刃 · 中速除外」，取前半段。 */
const SHORT = { blade: '炎刃', frost: '霜律', star: '星轨' } as const;

/**
 * 从「建房成功」推进到能看到对战桌。
 *
 * 建完房停在**准备页**，对战桌（含双方指挥官区）只有开局后才存在 ——
 * 所以必须点「准备」并把开局换牌跳过去，否则 `zone-commander` 永远不出现。
 * 顺序照抄 `helpers.startSoloGame`：它是这条链路的既有约定。
 */
async function enterTable(page: Page): Promise<void> {
  await page.getByTestId('ready').click();
  await expect(page.getByTestId('mulligan-skip')).toBeVisible({ timeout: WAIT });
  await page.getByTestId('mulligan-skip').click();
  await expect(page.getByTestId('turn')).toBeVisible({ timeout: WAIT });
}

test('人机可选对手卡组：选哪套，对手就是哪套的指挥官（#161）', async ({ browser }) => {
  for (const slug of ['frost', 'star', 'blade'] as const) {
    const page = await newClient(browser, `Solo-${slug}`);
    await page.getByTestId('opponent-deck').selectOption(slug);
    /*
     * 选择结果必须**当场可见**（写进按钮文案）。下拉只有 96px 宽、只放短词，
     * 若按钮不变，玩家就没有任何地方能确认自己选的是哪一套。
     */
    await expect(page.getByTestId('create-solo')).toContainText(`对手：${SHORT[slug]}`);
    await page.getByTestId('create-solo').click();
    await enterTable(page);

    /*
     * 对手指挥官区（`zone-commander` nth(0)）。
     *
     * 用 `toContainText` 而不是全等：区名/血量与卡名在同一个标题行里，
     * 全等会把「血 10」这类正文也算进去。这里只关心**是哪位指挥官**。
     */
    await expect(page.getByTestId('zone-commander').first()).toContainText(COMMANDERS[slug], {
      timeout: WAIT,
    });
    await page.context().close();
  }
});

test('不指定对手卡组时仍是「按房间码散列」，且默认就是这一项（#161）', async ({ browser }) => {
  const page = await newClient(browser, 'Solo-default');
  const select = page.getByTestId('opponent-deck');

  // 默认必须是「不指定」—— 把默认改成固定一套等于静默砍掉另外两套
  await expect(select).toHaveValue('');
  await expect(select.locator('option').first()).toContainText('不指定');
  // 选项一共 4 条：不指定 + 三套基础卡组。**必须在进桌前数** ——
  // 进了对战桌首页就卸载了，选择器连同 option 一起消失（会数出 0）。
  expect(await select.locator('option').count()).toBe(4);

  // 不选也能正常开局，对手仍是三套之一（散列没有被改成空/非法值）
  await page.getByTestId('create-solo').click();
  await enterTable(page);
  const opponent = page.getByTestId('zone-commander').first();
  await expect(opponent).toContainText(/炎刃军统领|霜律裁决官|星轨观测者/, { timeout: WAIT });

  await page.context().close();
});
