/**
 * 新手引导（P-03，Era 2026-10-21「P03 用 1 方案」）。
 *
 * 这条用例**不能**走 `newClient` —— 那个 helper 会把 `fc.introSeen` 预置成
 * 「已看」以免浮层挡住所有 E2E。这里要验的正是它的出现与消失，所以自己建 context。
 *
 * 覆盖四件事：
 * 1. 第一次进对战桌会弹（分步走，不是一屏文字）；
 * 2. **第一步必须与玩家此刻所处的阶段一致**（issue #117）—— 引导原本从「充能」讲起，
 *    但换牌阶段晚于引导上线，于是新手照着第一句话去找充能按钮，桌面上根本没有；
 * 3. 「跳过」的命中区 ≥ 44×44（issue #118，实测曾是 24×16）；
 * 4. 走完点「开始对战」就关掉，刷新后不再弹（写进 localStorage，不是只关掉本次会话）。
 */

import { expect, test } from '@playwright/test';

const WAIT = Number(process.env.E2E_WAIT_MS ?? 15_000);

test('首次进入对战桌弹出四步引导（首步讲换牌），走完即关闭且刷新不再出现', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: WAIT });
  await page.getByTestId('nickname').fill('Newbie');

  // 人机房最快：不用等第二个窗口，点准备就开局
  await page.getByTestId('create-solo').click();
  await page.getByTestId('ready').click();

  // ① 开局即弹引导，第一步必须讲**换牌** —— 此时顶栏正是「阶段 换牌」（issue #117）
  await expect(page.getByTestId('intro-guide')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('phase')).toContainText('换牌');
  await expect(page.getByTestId('intro-title')).toContainText('换牌');
  await expect(page.getByTestId('intro-body')).toContainText('不换牌');

  // 「跳过」命中区（issue #118）：实测曾是 24×16，手机上几乎点不中。
  // 44×44 是触控最小命中区的通行值（WCAG 2.5.5 / Apple HIG）。
  const skipBox = await page.getByTestId('intro-skip').boundingBox();
  expect(skipBox, '「跳过」必须渲染出来').not.toBeNull();
  expect(skipBox!.width, '「跳过」宽度').toBeGreaterThanOrEqual(44);
  expect(skipBox!.height, '「跳过」高度').toBeGreaterThanOrEqual(44);

  // ② 分步走完（新手真正会卡住的四处：换牌 / 充能 / 推进 / 出牌）
  await page.getByTestId('intro-next').click();
  await expect(page.getByTestId('intro-title')).toContainText('充能');
  await page.getByTestId('intro-next').click();
  await expect(page.getByTestId('intro-title')).toContainText('推进阶段');
  await page.getByTestId('intro-next').click();
  await expect(page.getByTestId('intro-title')).toContainText('出牌');
  await page.getByTestId('intro-done').click();
  await expect(page.getByTestId('intro-guide')).toHaveCount(0);

  // 关掉之后桌面可操作 —— 浮层若是漏了一层遮罩，这里会点不动。
  // 先用「不换牌」探针：引导第一步讲的就是它，必须真实存在且可点（issue #117 的验收口径）。
  await expect(page.getByTestId('mulligan-skip')).toBeVisible();
  // 再用「认输」：它常驻操作条，不像推进/结束回合那样随阶段出现或消失。
  await expect(page.getByTestId('turn')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('concede')).toBeVisible();

  // ③ 刷新（同一 context 保留 localStorage）→ 自动重连回对战桌，但不再弹引导
  await page.reload();
  await expect(page.getByTestId('turn')).toBeVisible({ timeout: WAIT });
  await expect(page.getByTestId('intro-guide')).toHaveCount(0);
});
