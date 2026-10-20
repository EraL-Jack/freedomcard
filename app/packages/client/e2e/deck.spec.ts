import { expect, test } from '@playwright/test';

import { newClient, readHand } from './helpers.js';

/**
 * 卡组编辑 → 设为开局卡组 → 建房 → 开局，**用户真实点击链**（D-158）。
 *
 * 为什么单独立一条：D-141 / D-143 的验证一直是「往协议里注入 30 个 defId」，
 * 那条路绕过了编辑页 —— 页面上的 `deck-total` / `use-deck` / `deck-in-use`
 * 三个锚点从来没被任何用例点过。注入路径测的是服务端校验，测不到「玩家点得通」。
 */

/** 10 张卡各 3 张 = 30 张（同名上限 3）。选的都是跨体系的常见卡，起手容易判定。 */
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

  // ③ 回主界面：下拉已带上这套自建卡组（id 是时间戳，只知道不是空）
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

/**
 * 基础卡组（D-169）能不能真的用来开局。
 *
 * 上一条测的是「自建卡组」（PICKS 手搓 10 种卡），这条测**预置的三套**：
 * 选一套 → 设为开局 → 建房开局 → 手牌必须全部来自那套配方。
 *
 * 分开测的理由：预置卡组的 id 是固定的（`basic-frost`），它能否被选择解析
 * 认出来、能否通过服务端校验，与"玩家现场搓出来的卡组"不是同一条路径。
 * 顺带覆盖 D-184：这套卡组自带的指挥官是霜律裁决官。
 */
test('基础卡组：选霜律一套开局，手牌全部来自霜律（D-169）', async ({ browser }) => {
  const host = await newClient(browser, 'BasicHost');

  await host.getByTestId('edit-deck').click();
  await host.getByTestId('deck-tab-basic-frost').click();
  await expect(host.getByTestId('deck-total')).toHaveText('30');
  await host.getByTestId('use-deck').click();
  await expect(host.getByTestId('deck-in-use')).toBeVisible();

  // D-184：基础卡组也带指挥官，界面上要能看见是「霜律裁决官」
  await expect(host.getByTestId('deck-commander-frostAdjudicator')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await host.getByRole('button', { name: '返回' }).click();
  await expect(host.getByTestId('deck-choice')).toHaveValue('basic-frost');

  await host.getByTestId('create').click();
  const code = ((await host.getByTestId('room-code').textContent()) ?? '').trim();

  const guest = await newClient(browser, 'BasicGuest');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(guest.getByTestId('ready')).toBeVisible({ timeout: 10_000 });

  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();
  await expect(host.getByTestId('turn')).toBeVisible({ timeout: 15_000 });

  // 开局后本方指挥官必须是霜律裁决官 —— 卡组与指挥官是从同一个选择里发出去的
  await expect(host.getByTestId('zone-commander').nth(1)).toContainText('霜律裁决官', {
    timeout: 15_000,
  });

  const hand = await readHand(host);
  expect(hand.length).toBeGreaterThanOrEqual(5);
  for (const c of hand) {
    expect(c.name.startsWith('霜律'), `手牌出现了非霜律卡：${c.name}`).toBe(true);
  }
});

/**
 * 卡组编辑里换指挥官（Era 2026-10-20 / D-184）。
 *
 * Era 的原话：「卡组编辑的时候还要有个地方选指挥官。」这条走完整点击链：
 * 编辑页换指挥官 → 设为开局 → 建房 → 开局，**服务端装出来的必须是刚选的那位**。
 *
 * 为什么必须端到端测：`commander` 是协议里的一个可选字段，最容易出的错是
 * 「客户端换了、入站被 strip、服务端还用旧的」—— 单测不到，界面上也看不出，
 * 只有打到一半发现技能不对才发现（和当年 `deck` / `payload` 是同一个坑）。
 */
test('编辑器里换指挥官：霜律主卡组 + 星轨指挥官，开局后按新指挥官装配（D-184）', async ({
  browser,
}) => {
  const host = await newClient(browser, 'CmdHost');

  await host.getByTestId('edit-deck').click();
  await host.getByTestId('deck-tab-basic-frost').click();
  await expect(host.getByTestId('deck-total')).toHaveText('30');

  // 默认是这套自带的霜律裁决官，换成星轨观测者
  await expect(host.getByTestId('deck-commander-frostAdjudicator')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await host.getByTestId('deck-commander-starWatcher').click();
  await expect(host.getByTestId('deck-commander-starWatcher')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // 换指挥官不影响主卡组合法性（卡池不限体系）
  await expect(host.getByTestId('deck-total')).toHaveText('30');
  await expect(host.getByTestId('deck-problems')).toContainText('合法');

  await host.getByTestId('use-deck').click();
  await expect(host.getByTestId('deck-in-use')).toBeVisible();
  await host.getByRole('button', { name: '返回' }).click();

  await host.getByTestId('create').click();
  const code = ((await host.getByTestId('room-code').textContent()) ?? '').trim();

  const guest = await newClient(browser, 'CmdGuest');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(guest.getByTestId('ready')).toBeVisible({ timeout: 10_000 });

  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();
  await expect(host.getByTestId('turn')).toBeVisible({ timeout: 15_000 });

  // 指挥官 = 星轨观测者；主卡组仍是霜律那 30 张（手牌全是霜律卡）
  await expect(host.getByTestId('zone-commander').nth(1)).toContainText('星轨观测者', {
    timeout: 15_000,
  });
  const hand = await readHand(host);
  expect(hand.length).toBeGreaterThanOrEqual(5);
  for (const c of hand) expect(c.name.startsWith('霜律'), `不该出现的卡：${c.name}`).toBe(true);
});
