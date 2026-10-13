import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * 房间流程端到端验证（占位界面）。
 *
 * 覆盖的是**真实浏览器 + 真实联机链路**，补上单测覆盖不到的那一层：
 * 点击是否真的生效、两个客户端是否真的互相看见、重开页面是否真的自动重连。
 *
 * ⚠️ 这里验证的是**占位界面**的可用性，不是产品界面 —— 视觉与交互设计仍待 B 组输入。
 */

async function newClient(browser: Browser, nickname: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('nickname').fill(nickname);
  return page;
}

test('建房 → 加入 → 双方可见 → 刷新自动重连', async ({ browser }) => {
  const host = await newClient(browser, 'Host');

  await host.getByTestId('create').click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toBeVisible({ timeout: 10_000 });
  const code = (await codeEl.textContent())?.trim() ?? '';
  expect(code).toMatch(/^[A-Z0-9]{4,8}$/);

  // 房主视角：先看到自己 1/2
  await expect(host.getByText('1/2 人')).toBeVisible({ timeout: 10_000 });

  const guest = await newClient(browser, 'Guest');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();

  // 双方都应看到 2/2
  await expect(host.getByText('2/2 人')).toBeVisible({ timeout: 10_000 });
  await expect(guest.getByText('2/2 人')).toBeVisible({ timeout: 10_000 });

  // 席位列表里应出现对方昵称（房主侧看到 Guest）
  await expect(host.getByTestId('seats')).toContainText('Guest');

  // 刷新页面 → 凭据在 localStorage，应自动重连回原房间。
  //
  // ⚠️ 刷新后落在**对战桌**而非主界面（B1 补充 3：加入房间即进入对战桌），
  // 因此这里不再断言主界面的「服务端已连接」，改为断言重连本身的事实：
  // notice 提示 + 房间码仍在。
  await host.reload();
  await expect(host.getByTestId('notice')).toContainText('已自动重连', { timeout: 10_000 });
  await expect(host.getByTestId('room-code')).toHaveText(code);

  // 离开后回到「不在房间内」
  await host.getByTestId('leave').click();
  await expect(host.getByText('当前不在房间内')).toBeVisible({ timeout: 10_000 });
});

test('满员后第三人加入被拒', async ({ browser }) => {
  const host = await newClient(browser, 'A');
  await host.getByTestId('create').click();
  const code = ((await host.getByTestId('room-code').textContent()) ?? '').trim();

  const b = await newClient(browser, 'B');
  await b.getByTestId('code').fill(code);
  await b.getByTestId('join').click();
  await expect(b.getByText('2/2 人')).toBeVisible({ timeout: 10_000 });

  const c = await newClient(browser, 'C');
  await c.getByTestId('code').fill(code);
  await c.getByTestId('join').click();
  // 错误码已映射为玩家能看懂的文案（D-108），断言跟着改为人话
  await expect(c.getByTestId('notice')).toContainText('房间已满', { timeout: 10_000 });
});

test('三档视口下占位界面不溢出', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: 15_000 });

  for (const [w, h] of [
    [375, 667],
    [768, 1024],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    // 横向不应出现溢出滚动
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${w}×${h} 出现横向溢出 ${overflow}px`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `e2e/screenshots/lobby-${w}.png`, fullPage: true });
  }
});
