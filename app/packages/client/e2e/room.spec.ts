import { expect, test } from '@playwright/test';

import { newClient } from './helpers.js';

/**
 * 房间流程端到端验证（占位界面）。
 *
 * 覆盖的是**真实浏览器 + 真实联机链路**，补上单测覆盖不到的那一层：
 * 点击是否真的生效、两个客户端是否真的互相看见、重开页面是否真的自动重连。
 *
 * ⚠️ 这里验证的是**占位界面**的可用性，不是产品界面 —— 视觉与交互设计仍待 B 组输入。
 *
 * ⚠️ T-02 同期修掉的坑：本文件原来**自己抄了一份 `newClient`**（与 `helpers.ts` 里的
 * 几乎一样）。于是给公共 helper 加「新手引导已看」预置时，本文件的三条用例全被
 * 引导浮层挡住 —— 表现为「点 leave 一直超时」，而错误里只提到 `intercepts pointer events`。
 * 同一份逻辑写两处，改一处必然漏另一处；现已改为从 `helpers.js` 导入。
 */

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

  // 离开后回到首页（issue #126：首页不再有「当前不在房间内。」这句话），
  // 用「建房入口回来了 + 房间码不在了」证明真的退出了 —— 断言界面事实，不依赖某句文案。
  await host.getByTestId('leave').click();
  await expect(host.getByTestId('create')).toBeVisible({ timeout: 10_000 });
  await expect(host.getByTestId('room-code')).toHaveCount(0);
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

test('对局中一方离开：另一方看到对局结束并可返回主界面（D-122）', async ({ browser }) => {
  const host = await newClient(browser, 'Host');
  await host.getByTestId('create').click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toBeVisible({ timeout: 10_000 });
  const code = ((await codeEl.textContent()) ?? '').trim();

  const guest = await newClient(browser, 'Guest');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(guest.getByText('2/2 人')).toBeVisible({ timeout: 10_000 });

  // 双方准备 → 开局
  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();
  await expect(host.getByTestId('turn')).toBeVisible({ timeout: 15_000 });

  // 一方中途离开 → 服务端系统代认输，另一方应看到「对局结束」面板而非空白页
  await guest.getByTestId('leave').click();
  await expect(host.getByTestId('game-result')).toHaveText('胜利', { timeout: 15_000 });

  // 结束面板提供出口：返回主界面
  await host.getByTestId('back-home').click();
  await expect(host.getByTestId('nickname')).toBeVisible({ timeout: 10_000 });
});

/**
 * 掉线可见化（D-233）：宽限期 60s 内，留下的一方顶栏要出现重连提示。
 *
 * 与上一条的区别：这里**不点「离开」**，直接关页面 —— 只有 socket 断开、
 * 没有 `room:leave`，走的正是「席位保留 + 等重连」那条路。
 */
test('对手掉线不点离开：席位保留，留下的一方顶栏出现 60 秒重连提示（D-233）', async ({ browser }) => {
  const host = await newClient(browser, 'Host');
  await host.getByTestId('create').click();
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toBeVisible({ timeout: 10_000 });
  const code = ((await codeEl.textContent()) ?? '').trim();

  const guest = await newClient(browser, 'Guest');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(guest.getByText('2/2 人')).toBeVisible({ timeout: 10_000 });

  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();
  await expect(host.getByTestId('turn')).toBeVisible({ timeout: 15_000 });

  // 直接关页面 = 断连（没有 room:leave）
  await guest.close();

  const badge = host.getByTestId('foe-offline');
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await expect(badge).toContainText('60');
  // 宽限期内**不判负** —— 席位还在等重连，结束面板不该出现
  await expect(host.getByTestId('game-result')).toHaveCount(0);
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
