import { expect, test } from '@playwright/test';

import { startGame } from './helpers.js';

/**
 * 联机开局端到端验证（真界面）。
 *
 * 覆盖单测覆盖不到的那一层：**两个真实浏览器 + 真实服务端**，
 * 走完「建房 → 加入 → 双方准备 → 开局 → 对战桌渲染」这条完整链路。
 *
 * ⚠️ 先后手由服务端掷骰决定（A2-4），故这里不断言「谁先手」，
 * 只断言双方都拿到了一致的对局事实。
 */

test('双方准备后开局，对战桌按 B2 布局渲染', async ({ browser }) => {
  const { host, guest } = await startGame(browser);

  // A10-1：起手 5 张
  await expect(host.getByTestId('hand').locator('[data-testid="card"]')).toHaveCount(5, {
    timeout: 10_000,
  });
  await expect(guest.getByTestId('hand').locator('[data-testid="card"]')).toHaveCount(5, {
    timeout: 10_000,
  });

  // 开局事件进了日志（说明客户端真的在 reduce 事件流）
  await expect(host.getByTestId('log')).toContainText('对局开始', { timeout: 10_000 });

  // X-1：指挥官在开局揭示。B2-4 上下镜像 —— 我方与对方**各有一个**指挥官区。
  await expect(host.getByTestId('zone-commander')).toHaveCount(2, { timeout: 10_000 });
  await expect(host.getByTestId('zone-commander').first()).toContainText('炎刃军统领', {
    timeout: 10_000,
  });

  // 费用区按 B2-3 直接显示数量
  await expect(host.getByTestId('zone-cost').first()).toBeVisible({ timeout: 10_000 });
});

test('卡牌详情：点「?」按钮可查看完整效果文本（Era 2026-10-18）', async ({ browser }) => {
  const { host } = await startGame(browser);

  // 指挥官区固定是炎刃军统领（卡面文本长、含多段效果），用它验证详情浮层。
  // 开局事件经播放队列逐条呈现，等指挥官区渲染出来。
  const commander = host.getByTestId('zone-commander').nth(1); // 镜像布局，nth(1) = 我方
  await expect(commander).toContainText('炎刃军统领', { timeout: 15_000 });

  await commander.locator('[data-testid="card-detail"]').click();
  const overlay = host.getByTestId('card-detail-overlay');
  await expect(overlay).toBeVisible();
  // 完整效果文本必须可见（不只是卡面摘要）—— 取统领效果 Ⅱ 的原文片段
  await expect(overlay).toContainText('可以将一张手牌除外');
  await expect(overlay).toContainText('成长档位');

  await host.getByTestId('card-detail-close').click();
  await expect(overlay).toHaveCount(0);
});
