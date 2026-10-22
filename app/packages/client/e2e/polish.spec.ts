import { expect, test } from '@playwright/test';

import {
  activePage,
  advancePhase,
  chargeMinions,
  costRemaining,
  payOf,
  pick,
  readHand,
  startGame,
  startSoloGame,
  zoneCount,
} from './helpers.js';

/**
 * 「打磨」类界面回归（issue #122 #123 #124 #128 #129 #130）。
 *
 * 这几条都是 T-0029 黑盒审计里「功能对、观感错」的那一类：引擎与协议全无问题，
 * 但玩家第一次上手会撞上。它们有一个共同点 —— **普通功能用例测不出来**：
 * 断言「按钮存在」不会发现按钮指向错的方向，断言「提示条可见」不会发现它压住了手牌。
 * 所以这里全部改用**几何事实**或**计算样式**做断言（矩形 / 字号 / scrollWidth），
 * 而不是文本存在性。
 *
 * ⚠️ 与 `home-layout.spec.ts` 分工：那边管首页的视口适配，这边管对战桌。
 */

const WAIT = Number(process.env.E2E_WAIT_MS ?? 15_000);

/** 移动端视口（issue #128 / #129 只在窄屏暴露）。 */
const MOBILE = { viewport: { width: 390, height: 844 }, hasTouch: true } as const;

test('右侧日志列不再有空白的对话框占位（#122）', async ({ browser }) => {
  test.setTimeout(90_000);
  const { host, guest } = await startGame(browser);
  const p = await activePage([host, guest]);

  const panel = p.getByTestId('log-panel');
  await expect(panel).toBeVisible({ timeout: WAIT });

  // ① 文案层：那个空块整块不该还在 DOM 里。
  await expect(p.getByText('对话框'), '右下不该再有「对话框（占位）」这种空承诺').toHaveCount(0);

  // ② 几何层：日志框必须吃满整列。
  //    只查文本是不够的 —— 换一句话把空块留着照样「没有『对话框』三个字」，
  //    但玩家看到的仍然是「有东西没加载出来」。空块的存在只能靠「下面还剩多少高度」证明。
  const pb = await panel.boundingBox();
  const lb = await p.getByTestId('log').boundingBox();
  expect(pb, '日志列应有可见矩形').not.toBeNull();
  expect(lb, '日志框应有可见矩形').not.toBeNull();
  const gap = pb!.y + pb!.height - (lb!.y + lb!.height);
  expect(gap, `日志框下方仍留 ${Math.round(gap)}px 空白（占位块还在？）`).toBeLessThanOrEqual(2);
});

test('换牌提示不再指向一个不存在的按钮（#123）', async ({ browser }) => {
  test.setTimeout(90_000);
  const { host, guest } = await startGame(browser, { skipMulligan: false });
  await expect(host.getByTestId('mulligan-skip')).toBeVisible({ timeout: WAIT });

  // ① 现场：未选牌时操作条上**确实没有**「确认换牌」——
  //    这不是 bug，是设计（选中才有提交对象）；bug 是提示条原来说「→「确认换牌」」，
  //    玩家照着找却找不到。
  await expect(host.getByTestId('mulligan-confirm')).toHaveCount(0);

  // ② 提示条必须自己交代清楚顺序：点牌 → 确认才出现；不想换直接点「不换牌」。
  const hint = (await host.getByTestId('phase-hint').innerText()) ?? '';
  expect(hint, `换牌提示应说明「确认换牌」是选中后才出现的：${hint}`).toContain('出现「确认换牌」');
  expect(hint, '提示里必须给出「不换牌」这个当场可用的出口').toContain('不换牌');

  // ③ 照着提示做一遍：点一张牌，确认按钮真的出现且计数为 1。
  await host.getByTestId('hand').locator('[data-testid="card"]').first().click();
  await expect(host.getByTestId('mulligan-confirm')).toContainText('确认换牌（1）');

  // ④ 收尾：双方都选「不换牌」，别把房间挂在换牌阶段（后面的用例不依赖这里）。
  await host.getByTestId('mulligan-clear').click();
  await host.getByTestId('mulligan-skip').click();
  await guest.getByTestId('mulligan-skip').click();
  await expect(host.getByTestId('mulligan-skip')).toHaveCount(0, { timeout: WAIT });
});

test('卡牌详情浮层按 Esc 关闭，且打开时焦点在浮层里（#124）', async ({ browser }) => {
  test.setTimeout(90_000);
  const { host, guest } = await startGame(browser);
  const p = await activePage([host, guest]);

  // 右键 = 桌面端看详情的入口（与长按等价，D-261）
  await p.getByTestId('hand').locator('[data-testid="card"]').first().click({ button: 'right' });
  const overlay = p.getByTestId('card-detail-overlay');
  await expect(overlay).toBeVisible({ timeout: WAIT });

  // 焦点必须已经移进浮层 —— 否则键盘用户的 Tab / 回车还在背后那张桌子上走
  await expect(p.getByTestId('card-detail-close')).toBeFocused();

  await p.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
});

test('移动端卡面数值不小于 12px（#128）', async ({ browser }) => {
  test.setTimeout(90_000);
  const { page } = await startSoloGame(browser, { contextOptions: MOBILE });

  const card = page.getByTestId('hand').locator('[data-testid="card"]').first();
  await expect(card).toBeVisible({ timeout: WAIT });

  // 量**计算后**的字号，不读 class：`text-xs` 是 12px，但如果哪天被别的规则覆盖，
  // 读 class 的断言仍会通过。这三个数就是玩家在手机上看牌的全部依据。
  for (const id of ['card-cost', 'card-power']) {
    const pill = card.getByTestId(id);
    // 先钉住锚点：没有锚点就量不到字号，红的时候要说清楚是哪一步
    await expect(pill, `卡面数值胶囊应有独立锚点 ${id}`).toHaveCount(1);
    const size = await pill.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size, `${id} 在 390px 下应 ≥12px，实测 ${size}px`).toBeGreaterThanOrEqual(12);
  }
});

test('移动端区域标题不被截断（#129）', async ({ browser }) => {
  test.setTimeout(90_000);
  const { page } = await startSoloGame(browser, { contextOptions: MOBILE });

  // 我方指挥官区（B2 镜像：同名区域第 2 个 = 我方）。
  // 取标题行的第一个 span 而不是 testid：这样**旧实现**（`truncate`）也能被定位，
  // 红的原因是「真的被裁了」，而不是「找不到锚点」—— 后者说明不了任何观感问题。
  const label = page.getByTestId('zone-commander').nth(1).locator('span').first();
  await expect(label).toHaveText('指挥官');

  // 文本完整 ≠ 没被裁：`truncate` 时 innerText 仍是全称，只有 scrollWidth 会露馅。
  const m = await label.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(m.scroll, `区名被压窄：scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeLessThanOrEqual(
    m.client + 1,
  );
});

test('选位置提示条不与手牌重叠（#130）', async ({ browser }) => {
  test.setTimeout(120_000);
  const { host, guest } = await startGame(browser);
  const p = await activePage([host, guest]);

  // 走到主要阶段，选一张付得起的随从点「出牌」。
  // `chargeMinions` 只留**最便宜**那张随从，所以这条链不会因为起手贵牌而卡住。
  await chargeMinions(p);
  await advancePhase(p, '抽牌');

  const hand = await readHand(p);
  const costZone = await zoneCount(p, 'cost', 1);
  const budget = await costRemaining(p);
  const minion = hand
    .filter((c) => c.kind === '随从')
    .filter((c) => payOf(c) <= costZone && payOf(c) <= budget)
    .sort((a, b) => payOf(a) - payOf(b))[0];
  expect(minion, `费用区 ${costZone} 张、本回合额度 ${budget}，应存在支付得起的随从`).toBeDefined();

  await pick(p, [minion!.index]);
  await p.getByTestId('play').click();

  const hint = p.getByTestId('placing-hint');
  await expect(hint).toBeVisible({ timeout: 5_000 });

  const hb = await hint.boundingBox();
  const handBox = await p.getByTestId('hand').boundingBox();
  expect(hb, '提示条应有可见矩形').not.toBeNull();
  expect(handBox, '手牌区应有可见矩形').not.toBeNull();

  // 判定「不重叠」用矩形相交，不用「看起来在下面」——
  // issue 的现场正是「提示条横跨全宽压在手牌下半」，两者 y 区间相交。
  const hBottom = hb!.y + hb!.height;
  const handBottom = handBox!.y + handBox!.height;
  const overlap = hBottom > handBox!.y + 1 && hb!.y < handBottom - 1;
  expect(
    overlap,
    `提示条 (y=${hb!.y}, h=${hb!.height}) 压住了手牌 (y=${handBox!.y}, h=${handBox!.height})`,
  ).toBe(false);

  // 提示条仍然在场（D-256 的「点了没反应」不能回来），且能取消
  await p.getByTestId('placing-cancel').click();
  await expect(hint).toHaveCount(0);
});

/** 两个矩形是否相交（留 1px 容差，避免亚像素误判）。 */
function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width - 1 &&
    b.x < a.x + a.width - 1 &&
    a.y < b.y + b.height - 1 &&
    b.y < a.y + a.height - 1
  );
}

test('回合横幅不压住我方随从格（#159-1）', async ({ browser }) => {
  const { host, guest } = await startGame(browser);
  const first = await activePage([host, guest]);
  const second = first === host ? guest : host;

  // 一方结束回合 → 另一方屏幕上出现「第 N 回合」横幅（停留 1100ms）
  await first.getByTestId('end-turn').click();

  /*
   * 必须按**文案**锁定回合横幅，不能「fx 一可见就量」。
   *
   * 事件是逐条播放的：结束回合先来「结束阶段」（`kind: 'phase'`，居中），
   * 「第 N 回合」（`kind: 'turn'`，贴顶）排在队列后面。只等 `fx` 可见会量到
   * 前一条居中横幅 —— 于是断言测的根本不是本轮修的横幅（首次跑就是这么红的）。
   */
  const fx = second.getByTestId('fx');
  await expect(fx, '回合横幅应该出现').toContainText('回合', { timeout: 30_000 });
  const fxBox = await fx.boundingBox();
  expect(fxBox, '横幅应有几何尺寸').not.toBeNull();

  /*
   * 我方第 2 格 —— issue 里被压住的正是这一格（1440×900 压第 2 格，390×844 压整排）。
   * `slot-1` 出现两次：nth(0)=对手、nth(1)=我方。
   */
  const slotBox = await second.getByTestId('slot-1').nth(1).boundingBox();
  expect(slotBox, '我方随从格应有几何尺寸').not.toBeNull();

  expect(
    intersects(fxBox!, slotBox!),
    `回合横幅 (y=${fxBox!.y}, h=${fxBox!.height}) 压住了我方随从格 (y=${slotBox!.y}, h=${slotBox!.height})`,
  ).toBe(false);
});

test('指挥官区不显示张数，只显示血量（#159-2）', async ({ browser }) => {
  const { page } = await startSoloGame(browser);

  const myCommander = page.getByTestId('zone-commander').nth(1);
  await expect(myCommander).toContainText('血');
  // 指挥官区恒为 1 张：「血 10 1」会被读成一个两位数
  await expect(myCommander.getByTestId('zone-count'), '指挥官区不该有张数').toHaveCount(0);
  // 其它区域照旧有张数 —— 别把这条修成「全都不显示」
  await expect(page.getByTestId('zone-cost').nth(1).getByTestId('zone-count')).toHaveCount(1);
});
