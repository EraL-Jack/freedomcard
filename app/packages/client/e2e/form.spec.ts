import { expect, test } from '@playwright/test';

import { newClient } from './helpers.js';

/**
 * 主界面表单 —— 两个都是 Era 2026-10-13 实机试玩反馈的问题：
 *
 * 1. **人数填 22 → 「操作失败：INVALID_PAYLOAD」，页面无跳转**。
 *    服务端上限 8，但客户端没有拦截，把超范围的数字原样发给服务器，
 *    被打回来又只显示一句天书错误码。修法是**本地折回**（22 → 8）：
 *    不发请求就能拦住的错误，不要等服务器打回。
 * 2. **输入的文字看不清楚** —— Tailwind preflight 不设置 input 的 color，
 *    浏览器默认黑字落在深色输入框上几乎不可读（修在 style.css 全局）。
 *    样式问题没法用 DOM 断言稳定验证，故此处只钉住行为修复。
 */

test('人数超出上限自动折回，建房成功而不是报 INVALID_PAYLOAD', async ({ browser }) => {
  const page = await newClient(browser, 'ClampTest');
  await page.getByTestId('capacity').fill('22');
  await page.getByTestId('create').click();

  // 建房成功 → 进入等待界面（有房间码），而不是停在主界面看错误提示
  await expect(page.getByTestId('room-code')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('notice')).toContainText('已建房', { timeout: 10_000 });
});

test('空昵称在本地拦截，不发请求', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: 15_000 });

  // 昵称留空（newClient 会填，这里清掉）
  await page.getByTestId('nickname').fill('');
  await page.getByTestId('create').click();

  await expect(page.getByTestId('local-error')).toContainText('请先填写昵称', {
    timeout: 5_000,
  });
  // 仍在主界面 —— 没有建房成功
  await expect(page.getByTestId('room-code')).toHaveCount(0);
});
