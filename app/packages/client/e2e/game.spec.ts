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
