/**
 * 危险操作的位置（issue #120）。
 *
 * ## 问题是什么
 *
 * 「认输」是有二次确认的，但**确认按钮长在了高频按钮旁边**：
 * 换牌阶段点「认输」后，红色「确认认输（本局判负）」紧贴紫色「不换牌」，间距 0。
 * 二次确认挡得住「不小心点了一次」，挡不住「手滑连点」。
 *
 * 战斗阶段的「取消攻击」与「认输」也只隔 4px、同一行同一高度。
 *
 * ## 判据
 *
 * 1. 确认态是**居中浮层**，确认按钮在浮层里（结构上离开了操作条）；
 * 2. 点「继续对战」只关浮层、不判负 —— 浮层不是单程票；
 * 3. 「取消攻击」与「认输」之间的水平间距 ≥ 16px（原来 gap-1 = 4px）。
 *
 * 第 3 条在 `combat.spec.ts` 里量（那里已经处在「选中攻击方」的状态），
 * 这里只覆盖换牌阶段这一半。
 */

import { expect, test } from '@playwright/test';

import { startSoloGame } from './helpers.js';

const WAIT = Number(process.env.E2E_WAIT_MS ?? 15_000);

test('认输确认是居中浮层，不贴在「不换牌」旁边；取消后仍在局内', async ({ browser }) => {
  // 换牌阶段就是这个问题的现场：操作条上同时有「不换牌」与「认输」。
  const { page } = await startSoloGame(browser, { skipMulligan: false });
  await expect(page.getByTestId('mulligan-skip')).toBeVisible({ timeout: WAIT });

  await page.getByTestId('concede').click();

  const dialog = page.getByTestId('concede-dialog');
  await expect(dialog).toBeVisible();

  // ① 结构：确认按钮在浮层内；操作条上的「认输」被浮层盖死（点不到才算真的挡住了）
  await expect(dialog.getByTestId('concede-confirm')).toBeVisible();
  const reachable = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="concede"]');
    if (!(btn instanceof HTMLElement)) return 'missing';
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === btn || btn.contains(hit) ? 'reachable' : 'covered';
  });
  expect(reachable, '浮层必须盖住操作条上的「认输」').toBe('covered');

  // ② 位置：浮层水平居中（换了位置才有意义 —— 原位加个红底挡不住连点）
  const viewport = page.viewportSize();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  if (viewport) {
    const centerOffset = Math.abs(box!.x + box!.width / 2 - viewport.width / 2);
    expect(centerOffset, '浮层应水平居中').toBeLessThanOrEqual(8);
  }

  // ③ 浮层与原按钮不相邻：垂直方向至少隔开一整行
  const skip = await page.getByTestId('mulligan-skip').boundingBox();
  const confirm = await dialog.getByTestId('concede-confirm').boundingBox();
  expect(skip).not.toBeNull();
  expect(confirm).not.toBeNull();
  const verticalGap = Math.min(
    Math.abs(confirm!.y - (skip!.y + skip!.height)),
    Math.abs(skip!.y - (confirm!.y + confirm!.height)),
  );
  expect(verticalGap, '确认按钮应与操作条拉开距离').toBeGreaterThanOrEqual(8);

  // ④ 取消 = 只关浮层，不是判负
  await page.getByTestId('concede-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('mulligan-skip')).toBeVisible();

  // ⑤ 真的认输才判负（浮层的确认仍然有效）—— 人机 BO1 单局，面板文案是「败北」
  await page.getByTestId('concede').click();
  await page.getByTestId('concede-confirm').click();
  await expect(page.getByTestId('game-result')).toHaveText('败北', { timeout: 20_000 });
});
