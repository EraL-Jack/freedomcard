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
