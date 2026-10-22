/**
 * 首页首屏布局（issue #116）。
 *
 * ## 为什么单开一条 spec
 *
 * 这是**纯视口**问题：1366×768 下页面内容高 932px，「编辑卡组」落在 top 834，
 * 完全在首屏之外（需滚 164px）。功能用例全都过，因为它们会先 `click()`
 * 自动滚过去 —— 只有量矩形才看得见。E2E 与实机截图互补的又一例。
 *
 * ## 判据为什么是「矩形 + 整页不溢出」
 *
 * 只断言 `toBeVisible()` 不够：Playwright 认为「在 DOM 里且有尺寸」就算可见，
 * 屏外元素照样返回 true。必须拿 `boundingBox()` 与视口高度比。
 * 另外补一条 `scrollHeight <= innerHeight`：只看按钮位置的话，把按钮挪到顶部、
 * 下面照样多出 200px 空白也能「通过」—— 那只是把问题挪走，不是修好。
 */

import { expect, test } from '@playwright/test';

import { newClient } from './helpers.js';

const VIEWPORTS = [
  { width: 1366, height: 768 }, // 最常见的笔记本分辨率之一（issue 报的就是它）
  { width: 1440, height: 900 },
  { width: 390, height: 844 }, // 手机：不要求整页不溢出（竖屏本来就长），只要求入口可达
] as const;

for (const viewport of VIEWPORTS) {
  test(`${viewport.width}×${viewport.height} 首页「编辑卡组」在首屏内且整页不溢出`, async ({
    browser,
  }) => {
    const page = await newClient(browser, 'Layout', { viewport });

    const box = await page.getByTestId('edit-deck').boundingBox();
    expect(box, '「编辑卡组」必须渲染出来').not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, '「编辑卡组」底边必须落在视口内').toBeLessThanOrEqual(viewport.height);

    // 手机竖屏不卡整页高度（内容本来就该能滚动），只记账不判定。
    if (viewport.width >= 1024) {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollHeight - window.innerHeight,
      );
      expect(overflow, '桌面视口下首页整体溢出高度').toBeLessThanOrEqual(0);
    }
  });
}
