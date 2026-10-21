/**
 * 点击反馈必须「看得见」（D-256）。
 *
 * ## 这条用例存在的理由
 *
 * Era 2026-10-21 第二次报「点击没反应，创建房间也没反应，人机对战也没反应」。
 * 查下来服务端好好的、建房链路也好好的 —— 真正的缺陷是**提示画在屏幕外**：
 * 390×844 的手机上，错误提示落在 `top≈900`，玩家点完按钮什么都看不到。
 *
 * 所以这里断言的不是「有没有提示」，而是「提示**在不在首屏**」。
 * 只断言 `toBeVisible()` 抓不到这个 bug —— 一个滚出屏幕的元素对 Playwright 来说
 * 依然是 visible 的（它在 DOM 里、有尺寸、没被隐藏），只有 `toBeInViewport()` 会红。
 */

import { expect, test } from '@playwright/test';

import { newClient } from './helpers.js';

/** 手机竖屏 —— 提示落在屏幕外正是这个尺寸下才发生的，桌面宽度测不出来。 */
const PHONE = { viewport: { width: 390, height: 844 } } as const;

test('建房出错时，提示要出现在首屏内，不用滚动就能看见', async ({ browser }) => {
  const page = await newClient(browser, 'Viewport', PHONE);

  // 触发本地校验：昵称 25 个字（上限 24）—— 不发请求就能拦住的那一类
  await page.getByTestId('nickname').fill('一二三四五六七八九十一二三四五六七八九十一二三四五');
  await page.getByTestId('create-solo').click();

  const err = page.getByTestId('local-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText('最多 24');
  // 核心断言：不能只存在于 DOM 里，必须在玩家眼睛能看到的位置
  await expect(err).toBeInViewport();

  // 提示不能把两个建房按钮挤到屏幕外 —— 修好一个坑不能再挖一个
  await expect(page.getByTestId('create')).toBeInViewport();
  await expect(page.getByTestId('create-solo')).toBeInViewport();

  await page.context().close();
});

test('服务端回绝时（房码不存在），提示同样落在首屏内', async ({ browser }) => {
  const page = await newClient(browser, 'Viewport', PHONE);

  // 走到服务端的那条路径：房码不存在 → `room:join` 返回 ok:false
  await page.getByTestId('code').fill('ZZZZZZ');
  await page.getByTestId('join').click();

  const notice = page.getByTestId('notice');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toBeInViewport();

  await page.context().close();
});
