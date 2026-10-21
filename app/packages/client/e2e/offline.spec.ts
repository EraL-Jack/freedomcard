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

/**
 * 资源加载失败时的兜底提示（issue #107 / D-273）。
 *
 * Era 2026-10-21 手机浏览器「样式没了」：样式表请求失败时浏览器**不重试也不报错**，
 * 页面静默变成白底黑字，玩家只能认为游戏坏了。
 *
 * 这里不能靠 `page.route` 拦截 `*.css` —— dev 态样式由 JS 注入、没有单独的 CSS 请求。
 * 改成插一个真的加载不到的 `<link rel=stylesheet>`：浏览器自己触发 error 事件，
 * 走的是与线上完全相同的兜底分支。
 */
test('样式表加载失败时，页面给出「请刷新重试」而不是静默白纸', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('asset-error')).toHaveCount(0);

  /*
   * ⚠️ 不能用「指向一个不存在的 .css」来制造失败：Vite dev 的 SPA 回退会回
   * `200 + text/html`，浏览器把它当**加载成功**（`onload`，只是解析出 0 条规则）——
   * 实测确认过，`onerror` 根本不触发。线上修好之后缺失资源是 404，会触发 error；
   * 隧道丢包则是网络失败，同样触发 error。
   *
   * 所以这里用 `route.abort()` 模拟**请求失败**（= 隧道那条路径），
   * 与线上失败时的兜底分支完全一致。
   */
  await page.route('**/issue-107-missing.css', (route) => route.abort());
  await page.evaluate(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/issue-107-missing.css';
    document.head.appendChild(link);
  });

  await expect(page.getByTestId('asset-error')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('asset-error')).toContainText('刷新');
});
