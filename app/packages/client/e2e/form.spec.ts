import { expect, test } from '@playwright/test';

import { newClient } from './helpers.js';

/**
 * 主界面表单 —— 两个都是 Era 2026-10-13 实机试玩反馈的问题：
 *
 * 1. **人数填 22 → 「操作失败：INVALID_PAYLOAD」，页面无跳转**。
 *    当时的修法是本地折回（22 → 8）。**T-07 / D-244 之后人数输入已整体删除**：
 *    规则只验证过 2 人，现在无论传几都建双人房，玩家没有必要填这个数。
 *    这条用例因此改成「没有人数输入也能建房」，守住「删输入后建房链路没坏」。
 * 2. **输入的文字看不清楚** —— Tailwind preflight 不设置 input 的 color，
 *    浏览器默认黑字落在深色输入框上几乎不可读（修在 style.css 全局）。
 *    样式问题没法用 DOM 断言稳定验证，故此处只钉住行为修复。
 *
 * 另加 H18：回合时限在建房可选（30 / 60 / 180 / 999 秒），选完要在准备页看得见。
 */

test('没有人数字段也能建房 —— 房间恒为 2 人（T-07）', async ({ browser }) => {
  const page = await newClient(browser, 'NoCapacity');
  await expect(page.getByTestId('capacity')).toHaveCount(0);
  await page.getByTestId('create').click();

  // 建房成功 → 进入等待界面（有房间码），而不是停在主界面看错误提示
  await expect(page.getByTestId('room-code')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('notice')).toContainText('已建房', { timeout: 10_000 });
  await expect(page.getByText('1/2 人 · lobby')).toBeVisible();
});

test('回合时限可选，选中的档位传进房间并在准备页显示（H18）', async ({ browser }) => {
  const page = await newClient(browser, 'TimePick');
  await page.getByTestId('turn-timeout').selectOption('999000');
  await page.getByTestId('create').click();

  await expect(page.getByTestId('room-code')).toBeVisible({ timeout: 10_000 });
  // 服务端回写的房间视图带着 turnTimeoutMs —— 对手也要知道这局每回合给多久
  await expect(page.getByTestId('room-rules')).toContainText('999 秒（基本不限时）');
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
