import { expect, test } from '@playwright/test';

import { newClient, readHand } from './helpers.js';

/**
 * 卡组编辑 → 设为开局卡组 → 建房 → 开局，**用户真实点击链**（D-158）。
 *
 * 为什么单独立一条：D-141 / D-143 的验证一直是「往协议里注入 30 个 defId」，
 * 那条路绕过了编辑页 —— 页面上的 `deck-total` / `use-deck` / `deck-in-use`
 * 三个锚点从来没被任何用例点过。注入路径测的是服务端校验，测不到「玩家点得通」。
 */

/** 10 张卡各 3 张 = 30 张（同名上限 3）。选的都是跨阵营的常见卡，起手容易判定。 */
const PICKS: readonly { defId: string; name: string }[] = [
  { defId: 'bladeVanguard', name: '炎刃军先锋' },
  { defId: 'bladeScout', name: '炎刃斥候' },
  { defId: 'bladeRecruit', name: '炎刃新兵' },
  { defId: 'bladeGuard', name: '炎刃卫士' },
  { defId: 'bladeOrder', name: '炎刃号令' },
  { defId: 'frostRecruit', name: '霜律新兵' },
  { defId: 'frostApprentice', name: '霜律学徒' },
  { defId: 'frostWarden', name: '霜律戍卫' },
  { defId: 'frostEdict', name: '霜律律令' },
  { defId: 'frostColdSnap', name: '霜律寒流' },
];

test('编辑卡组 → 设为开局 → 建房开局，手牌来自自建卡组（D-158）', async ({ browser }) => {
  const host = await newClient(browser, 'DeckHost');

  // ① 编辑页：新建 → 每张点 3 次 → 30/30
  await host.getByTestId('edit-deck').click();
  await host.getByTestId('deck-new').click();
  for (const p of PICKS) {
    for (let i = 0; i < 3; i++) await host.getByTestId(`deck-add-${p.defId}`).click();
  }
  await expect(host.getByTestId('deck-total')).toHaveText('30');

  // ② 设为开局卡组 —— 不返回主界面也能设（D-143）
  await host.getByTestId('use-deck').click();
  await expect(host.getByTestId('deck-in-use')).toBeVisible();

  // ③ 回主界面：下拉已带上这套卡组
  await host.getByRole('button', { name: '返回' }).click();
  await expect(host.getByTestId('deck-choice')).not.toHaveValue('');

  // ④ 建房 + 加入 + 准备
  await host.getByTestId('create').click();
  const code = ((await host.getByTestId('room-code').textContent()) ?? '').trim();
  expect(code.length).toBeGreaterThan(0);

  const guest = await newClient(browser, 'DeckGuest');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(guest.getByTestId('ready')).toBeVisible({ timeout: 10_000 });

  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();
  await expect(host.getByTestId('turn')).toBeVisible({ timeout: 15_000 });

  // ⑤ 开局手牌全部来自自建卡组（默认卡组里含大量别的卡，混进来就会红）
  await expect
    .poll(async () => (await readHand(host)).length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(5);
  const hand = await readHand(host);
  const allowed = new Set(PICKS.map((p) => p.name));
  for (const c of hand) expect(allowed.has(c.name), `不该出现的卡：${c.name}`).toBe(true);
});
