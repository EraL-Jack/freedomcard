/**
 * 390px 竖屏的对战桌（T-02）。
 *
 * 原来的问题：右侧日志列写的是 `hidden sm:flex`，于是在手机宽度下**整列消失** ——
 * 战报（谁打了谁、破坏了什么）在手机上看不到，玩家只能靠猜。
 *
 * 现在窄屏改为「日志」按钮展开的抽屉。这条用例钉三件事：
 * 1. 窄屏有入口按钮（而不是什么都没有）；
 * 2. 默认收起，点开后能看到日志内容；
 * 3. 能收起（抽屉是 fixed 覆盖整屏，关不掉就再也点不到桌面）。
 *
 * 桌面上日志列仍常驻（`sm:flex`），所以这里只在移动视口断言。
 */

import { expect, test } from '@playwright/test';

const WAIT = Number(process.env.E2E_WAIT_MS ?? 15_000);

test('390px 竖屏：日志不再消失，可展开 / 收起（T-02）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  // 新手引导会盖住整屏 —— 本用例只看日志抽屉，预置成已看
  await page.addInitScript(() => {
    try {
      localStorage.setItem('fc.introSeen', '1');
    } catch {
      /* 忽略 */
    }
  });
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: WAIT });
  await page.getByTestId('nickname').fill('Phone');

  await page.getByTestId('create-solo').click();
  await page.getByTestId('ready').click();
  await expect(page.getByTestId('turn')).toBeVisible({ timeout: WAIT });

  // ① 窄屏有入口，且默认收起（不能一上来就盖住半个桌面）
  await expect(page.getByTestId('log-toggle')).toBeVisible();
  await expect(page.getByTestId('log')).toBeHidden();

  // ② 展开 → 日志可见且有内容（开局必然写了「洗牌 / 起手」这类条目）
  await page.getByTestId('log-toggle').click();
  await expect(page.getByTestId('log')).toBeVisible();
  await expect(page.getByTestId('log')).not.toBeEmpty();

  // ③ 收起 → 回到桌面（抽屉关不掉的话，之后所有操作都会被它挡住）
  await page.getByTestId('log-close').click();
  await expect(page.getByTestId('log')).toBeHidden();
});
