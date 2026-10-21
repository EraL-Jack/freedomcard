/**
 * 断线时的可操作性（D-255，Era 2026-10-21「点击人机对战没反应」）。
 *
 * 根因不是业务逻辑：socket.io 在未连接时 `emit` 会**静默进队列**，
 * 按钮点下去一点反馈都没有，玩家只能反复点。
 * 所以断线时把按钮置灰、把原因写在页面上 —— 能判断的状态不该丢给玩家猜。
 *
 * 两个用例分开写：
 * 1. **不可达**：提示行出现、三个入口全部不可点；
 * 2. **可达**：提示行不出现、按钮可用、真的能开人机房。
 *
 * ⚠️ 掐断 socket 要掐**两条通道**：客户端是 `transports: ['websocket','polling']`
 * （`socket.ts`），优先走 WebSocket，而 `page.route` 拦不到 WebSocket 升级 ——
 * 只 abort HTTP 的话页面照样显示「服务端已连接」。
 *
 * 这条用例**不能**走 `newClient` —— 那个 helper 会等「服务端已连接」才返回。
 */

import { expect, test } from '@playwright/test';

const SOCKET_PATH = /socket\.io/;

test('服务端不可达时，建房与人机对战按钮置灰并说明原因', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.routeWebSocket(SOCKET_PATH, (ws) => ws.close());
  await page.route('**/socket.io/**', (route) => route.abort());
  await page.goto('/');

  await expect(page.getByTestId('offline-hint')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('create')).toBeDisabled();
  await expect(page.getByTestId('create-solo')).toBeDisabled();
  await expect(page.getByTestId('join')).toBeDisabled();

  await context.close();
});

test('连上之后按钮可用，人机对战能真的开局', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: 15_000 });

  // 连接正常时不该出现断线提示，否则置灰会变成常态化的死路
  await expect(page.getByTestId('offline-hint')).toHaveCount(0);

  await page.getByTestId('nickname').fill('Offline');
  await page.getByTestId('create-solo').click();
  await expect(page.getByTestId('room-code')).toBeVisible({ timeout: 15_000 });

  await context.close();
});
