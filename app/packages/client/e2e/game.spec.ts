import { expect, test, type Page } from '@playwright/test';

import { startGame, newClient } from './helpers.js';

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

  // docs/16 §1：先手 5 张、后手 6 张（先后手由掷骰决定，故只断言两侧合起来是 5 + 6）
  await expect
    .poll(async () => {
      const hostHand = await host.getByTestId('hand').locator('[data-testid="card"]').count();
      const guestHand = await guest.getByTestId('hand').locator('[data-testid="card"]').count();
      return [hostHand, guestHand].sort((a, b) => a - b);
    })
    .toEqual([5, 6]);

  // 开局事件进了日志（说明客户端真的在 reduce 事件流）
  await expect(host.getByTestId('log')).toContainText('对局开始', { timeout: 10_000 });

  // X-1：指挥官在开局揭示。B2-4 上下镜像 —— 我方与对方**各有一个**指挥官区。
  await expect(host.getByTestId('zone-commander')).toHaveCount(2, { timeout: 10_000 });
  // ADR-0025：座位 0 = 炎刃、座位 1 = 霜律；host 是座位 0，其**我方**指挥官（nth(1)）是炎刃
  await expect(host.getByTestId('zone-commander').nth(1)).toContainText('炎刃军统领', {
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
  // 完整效果文本必须可见（不只是卡面摘要）—— 取统领效果 Ⅱ 的规范写法片段（docs/18）
  await expect(overlay).toContainText('将 1 张手牌除外');
  // 指挥官没有力量值（docs/16 §6.2.1 / D-230）：详情里不再出现力量值与成长档位
  await expect(overlay).not.toContainText('成长档位');
  await expect(overlay).not.toContainText('· 力 ');

  await host.getByTestId('card-detail-close').click();
  await expect(overlay).toHaveCount(0);
});

test('统领效果Ⅱ：发动 → 选择手牌 → 除外（ADR-0023 / X-16）', async ({ browser }) => {
  const { host, guest } = await startGame(browser);
  // 效果发动要求是我的回合，且统领是**炎刃**指挥官（ADR-0025：座位 0 = host = 炎刃）。
  // 若首回合行动方是 guest，先让它结束回合，把回合交给 host。
  const p = host;
  if (!(await p.getByText('你的回合').isVisible())) {
    await guest.getByTestId('end-turn').click();
    await expect(p.getByText('你的回合')).toBeVisible({ timeout: 20_000 });
  }

  const handBefore = await p.getByTestId('hand').locator('[data-testid="card"]').count();

  // 打开我方指挥官详情 → 发动效果Ⅱ
  const commander = p.getByTestId('zone-commander').nth(1);
  await expect(commander).toContainText('炎刃军统领', { timeout: 15_000 });
  await commander.locator('[data-testid="card-detail"]').click();
  await p.getByTestId('effect-2').click();

  // 待定选择浮层：列出全部手牌供选择
  const overlay = p.getByTestId('choice-overlay');
  await expect(overlay).toBeVisible({ timeout: 10_000 });
  await overlay.getByTestId('choice-card').first().click();

  // 手牌少一张，除外区 +1
  await expect(p.getByTestId('hand').locator('[data-testid="card"]')).toHaveCount(handBefore - 1, {
    timeout: 10_000,
  });
  await expect(p.getByTestId('zone-exile').nth(1)).toContainText('1', { timeout: 10_000 });
});

test('赛制与阵营：建房选 BO3 + 星轨，开局显示比分与星轨资源（D-132 / D-235）', async ({ browser }) => {
  const { host, guest } = await startGame(browser, {
    format: 'bo3',
    hostFaction: 'star',
    guestFaction: 'frost',
  });

  // 赛制标记：BO3 才显示「第 N 局 · 比分 X : Y」
  await expect(host.getByTestId('series')).toContainText('比分', { timeout: 15_000 });
  await expect(host.getByTestId('series')).toContainText('第 1 局');

  // 阵营选的星轨 → 我方指挥官是星轨观测者，成长资源是「星轨 N」
  await expect(host.getByTestId('zone-commander').nth(1)).toContainText('星轨观测者', {
    timeout: 15_000,
  });
  await expect(host.getByTestId('my-growth')).toContainText('星轨', { timeout: 10_000 });

  // 对手选霜律 → 在 guest 自己的界面里，nth(1) 是「我方指挥官」= 霜律裁决官
  await expect(guest.getByTestId('zone-commander').nth(1)).toContainText('霜律裁决官', {
    timeout: 15_000,
  });
  // guest 看到的对方（host）指挥官是星轨观测者
  await expect(guest.getByTestId('zone-commander').nth(0)).toContainText('星轨观测者', {
    timeout: 15_000,
  });

  // BO1 房间不出现赛制条（避免占位噪音）
  const bo1 = await startGame(browser);
  await expect(bo1.host.getByTestId('series')).toHaveCount(0);
});

test('BO3 中一方离开：系列赛直接判负，不再停在「等待下一局」(D-132)', async ({ browser }) => {
  const { host, guest } = await startGame(browser, { format: 'bo3' });
  await expect(guest.getByTestId('turn')).toBeVisible({ timeout: 15_000 });

  // 离开者：返回主界面 = leave（服务端系统代认输 + 判负系列赛）
  await guest.getByTestId('leave').click();

  // 留下的人看到结束面板与比分，且不应出现「开始下一局」
  await expect(host.getByTestId('game-result')).toBeVisible({ timeout: 20_000 });
  await expect(host.getByTestId('series-score')).toContainText('BO3', { timeout: 10_000 });
  await expect(host.getByTestId('next-game')).toHaveCount(0);
});

/**
 * 自建卡组接入开局（D-141）。
 *
 * 覆盖链路：本地卡组 → 建房 payload → 服务端校验 → 开局装配。
 * 用「全霜律卡组」是为了可判定：默认炎刃卡组里没有任何「霜律」卡，
 * 手牌出现「霜律」即证明我方主卡组确实换成了自建那 30 张。
 */
test('自建卡组：对局前选中，开局后使用该卡组（D-141）', async ({ browser }) => {
  /** 与 `FROST_MAIN_DECK_RECIPE` 同构（30 张，同名 ≤3）。 */
  const recipe = {
    frostRecruit: 2,
    frostApprentice: 3,
    frostWarden: 3,
    frostEdict: 2,
    frostBinder: 3,
    frostLancer: 3,
    frostColdSnap: 1,
    frostEnforcer: 2,
    frostDomain: 2,
    frostNightwatch: 2,
    frostJailer: 2,
    frostJudgment: 2,
    frostFinalJudgment: 1,
    frostWinterblade: 2,
  };

  const host = await newClient(browser, 'Host');
  // 直接写 localStorage（等价于在卡组编辑器里建好并选中）
  await host.evaluate((cards) => {
    localStorage.setItem(
      'fc.decks',
      JSON.stringify([{ id: 'e2e-frost', name: 'E2E 霜律', cards }]),
    );
    localStorage.setItem('fc.activeDeckId', 'e2e-frost');
  }, recipe);
  await host.reload();
  await expect(host.getByText('服务端已连接')).toBeVisible({ timeout: 15_000 });
  await host.getByTestId('nickname').fill('Host');
  // 下拉已从 localStorage 恢复为自建卡组
  await expect(host.getByTestId('deck-choice')).toHaveValue('e2e-frost');

  await host.getByTestId('create').click();
  const code = ((await host.getByTestId('room-code').textContent()) ?? '').trim();

  // 准备页也能换（D-141）：切回阵营默认再切回自建，服务端两次都应接受
  await host.getByTestId('waiting-deck').selectOption('');
  await host.getByTestId('waiting-deck').selectOption('e2e-frost');

  const guest = await newClient(browser, 'Guest');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(guest.getByTestId('ready')).toBeVisible({ timeout: 10_000 });

  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();
  await expect(host.getByTestId('turn')).toBeVisible({ timeout: 15_000 });

  // 默认炎刃卡组里没有霜律卡 —— 手牌出现「霜律」即证明自建卡组生效
  await expect(host.getByTestId('hand')).toContainText('霜律', { timeout: 10_000 });
});

/**
 * 认输入口 + BO3 第 3 局败者先攻（D-147 / H33）。
 *
 * 此前客户端只有「离开」，而离开在 BO3 里判负**整个系列赛** —— 没法只输一局，
 * 也导致「打到 1:1」这条链路无法端到端验证。补上认输按钮后一并覆盖：
 * 第 1 局 host 认输 → 第 2 局 guest 认输（1:1）→ 第 3 局先手应是第 2 局败者 guest。
 *
 * 判据用起手张数：先手 5 张、后手 6 张（docs/16 §1.2）。
 */
test('认输只判负本局；BO3 第 3 局由上一局败者先攻（D-147 / H33）', async ({ browser }) => {
  const { host, guest } = await startGame(browser, { format: 'bo3' });
  const handCount = (p: Page): Promise<number> =>
    p.getByTestId('hand').locator('[data-testid="card"]').count();

  // 第 1 小局：host 认输（两段式确认）→ guest 胜，系列赛 0:1，房间进入「等待下一局」
  await host.getByTestId('concede').click();
  await host.getByTestId('concede-confirm').click();
  await expect(host.getByTestId('game-result')).toHaveText('本局败北', { timeout: 20_000 });
  await expect(guest.getByTestId('game-result')).toHaveText('本局胜利', { timeout: 20_000 });
  // 回放入口置灰（D-183）：入口在结算面板可见，但不可点。
  // 断言的是「显示 + disabled」两件事 —— 只断言 disabled 的话，按钮被删掉也照样过。
  await expect(host.getByTestId('replay-view')).toBeVisible();
  await expect(host.getByTestId('replay-view')).toBeDisabled();
  await expect(host.getByTestId('replay-view')).toHaveText('查看回放（暂未开放）');
  // 认输 ≠ 离开：房主仍能开下一局（离开会直接把 seriesWinner 写死）
  await expect(host.getByTestId('next-game')).toBeVisible({ timeout: 10_000 });

  // 第 2 小局：guest 认输 → host 胜 → 1:1
  await host.getByTestId('next-game').click();
  await expect(guest.getByTestId('turn')).toBeVisible({ timeout: 20_000 });
  await guest.getByTestId('concede').click();
  await guest.getByTestId('concede-confirm').click();
  await expect(host.getByTestId('game-result')).toHaveText('本局胜利', { timeout: 20_000 });
  await expect(host.getByTestId('series-score')).toContainText('我 1 : 1 对手', {
    timeout: 10_000,
  });

  // 第 3 小局：先手 = 第 2 局败者 guest（H33 取代原先的重新掷骰）
  await host.getByTestId('next-game').click();
  await expect(host.getByTestId('series')).toContainText('第 3 局', { timeout: 20_000 });
  await expect.poll(() => handCount(guest)).toBe(5);
  await expect.poll(() => handCount(host)).toBe(6);
  await expect(guest.getByText('你的回合')).toBeVisible({ timeout: 10_000 });
});
