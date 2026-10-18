import { expect, type Browser, type Page } from '@playwright/test';

/**
 * E2E 公共辅助。
 *
 * 单独成文件是因为两条 spec 都要「建房 → 加入 → 双方准备 → 开局」，
 * 且都要读对局事实（手牌 / 区域张数 / 当前行动方）—— 重复写两份会在
 * 界面演进时改漏一处。
 */

/** 开一个已连上服务端的客户端页面。 */
export async function newClient(browser: Browser, nickname: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('nickname').fill(nickname);
  return page;
}

/** 建房 + 加入 + 双方准备，返回两个已开局的页面。 */
export async function startGame(browser: Browser): Promise<{ host: Page; guest: Page; code: string }> {
  const host = await newClient(browser, 'Host');
  await host.getByTestId('create').click();
  const code = ((await host.getByTestId('room-code').textContent()) ?? '').trim();

  const guest = await newClient(browser, 'Guest');
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(guest.getByTestId('ready')).toBeVisible({ timeout: 10_000 });

  // 双方准备 → 服务端建立对局（ADR-0019）
  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();

  await expect(host.getByTestId('turn')).toBeVisible({ timeout: 15_000 });
  await expect(guest.getByTestId('turn')).toBeVisible({ timeout: 15_000 });
  return { host, guest, code };
}

/**
 * 当前**行动方**所在的页面。
 *
 * ⚠️ 先后手由服务端掷骰决定（A2-4），不能假设 host 先手，只能从界面反推。
 *
 * ⚠️ **必须等状态稳定，不能判断一次就返回**（实测踩过）：
 * 客户端是**逐条 reduce 开局事件**的，而在事件流全部到达之前
 * `activeSeat` 仍是 `createInitialState` 的初始值，此时先渲染出来的那个页面
 * 会短暂地以为「轮到我」（按钮 enabled、文案显示「你的回合」）；
 * 等 `turn:changed` 事件到达，真正的先攻方才揭晓。判断过早会选中错的页面，
 * 表现为「点了充能没反应」—— 因为按钮在那之后已经 disabled 了。
 *
 * 故这里要求**连续多次检测到同一个页面为行动方**才返回。
 */
export async function activePage(pages: readonly Page[]): Promise<Page> {
  let stable: Page | null = null;
  let hits = 0;

  await expect
    .poll(
      async () => {
        const active: Page[] = [];
        for (const p of pages) {
          if (await p.getByText('你的回合').isVisible()) active.push(p);
        }
        // 必须恰好一个 —— 0 个说明还没开局，2 个说明状态不一致（不该发生）
        if (active.length !== 1) {
          stable = null;
          hits = 0;
          return false;
        }
        const found = active[0]!;
        if (found === stable) hits += 1;
        else {
          stable = found;
          hits = 1;
        }
        return hits >= 3;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  return stable!;
}

export interface HandCard {
  /** 在手牌区中的序号 —— 点击时的定位依据。 */
  index: number;
  name: string;
  cost: number;
  /** 卡面类型标签文本，如「随从」「法术」。 */
  kind: string;
}

/** 读我方手牌（从占位卡面上解析名称 / 费用 / 类型）。 */
export async function readHand(page: Page): Promise<HandCard[]> {
  const cards = page.getByTestId('hand').locator('[data-testid="card"]');
  const n = await cards.count();
  const out: HandCard[] = [];
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const text = (await card.innerText()) ?? '';
    out.push({
      index: i,
      name: text.split('\n')[0]?.trim() ?? '',
      cost: Number(/费\s*(\d+)/.exec(text)?.[1] ?? NaN),
      kind: ((await card.getByTestId('card-kind').innerText()) ?? '').trim(),
    });
  }
  return out;
}

/** 选中手牌中的一张（D-112 起选中**排他**：点一张即选中，再点取消或换选）。 */
export async function pick(page: Page, indices: readonly number[]): Promise<void> {
  const cards = page.getByTestId('hand').locator('[data-testid="card"]');
  for (const i of indices) await cards.nth(i).click();
}

/**
 * 在充能阶段**逐张**充能随从。
 *
 * D-112 起选中排他 + 操作按钮挂在卡旁（Era 2026-10-18），「多张充能」
 * 在界面上 = 多次「点一张 → 点卡旁的充能按钮」（规则侧 X-2 允许任意数量，
 * 协议支持逐张发，二者等价）。
 *
 * 每充一张手牌就变化，故每轮重读手牌；留一张随从不出（供后续出牌测试）。
 * 返回实际充能张数。
 */
export async function chargeMinions(page: Page): Promise<number> {
  // 从**当前**费用区张数起算（调用前可能已有拖拽充能，drag.spec 2026-10-18）。
  // 返回充能完成后费用区的总张数。
  let total = await zoneCount(page, 'cost', 1);
  for (;;) {
    const hand = await readHand(page);
    const minions = hand.filter((c) => c.kind === '随从');
    if (minions.length <= 1) break; // 留一张随从供出牌；极端牌序（起手仅 1 随从）则充 0 张
    await pick(page, [minions[0]!.index]);
    await page.getByTestId('charge').click();
    total += 1;
    await expect.poll(() => zoneCount(page, 'cost', 1)).toBe(total);
  }
  return total;
}

/**
 * 区域显示的张数。
 *
 * ⚠️ B2 布局是**上下镜像**的：对方与我都各有同名区域，故必须指定第几个
 * （`zone-graveyard` 的 0 = 对方第 ② 排，1 = 我方第 ⑤ 排；
 *   `zone-cost` 的 0 = 对方第 ③ 排，1 = 我方第 ④ 排）。
 *
 * ⚠️ 取的是文本里**最后一个**数字 —— 指挥官区带血量徽标（「血 12」），
 * 取最后一个才能稳定拿到卡数而不是血量。
 */
export async function zoneCount(page: Page, zone: string, nth = 0): Promise<number> {
  const text = (await page.getByTestId(`zone-${zone}`).nth(nth).innerText()) ?? '';
  const nums = text.match(/\d+/g);
  return nums && nums.length > 0 ? Number(nums[nums.length - 1]) : Number.NaN;
}

/** 当前回合数（从「第 N 回合」解析）。 */
export async function turnNo(page: Page): Promise<number> {
  const text = (await page.getByTestId('turn').innerText()) ?? '';
  return Number(/(\d+)/.exec(text)?.[1] ?? NaN);
}

/** 当前阶段名（从 header 的「阶段 X」解析）。 */
export async function phaseText(page: Page): Promise<string> {
  return ((await page.locator('header').innerText()) ?? '').trim();
}

/**
 * 推进一个阶段并断言到位。
 *
 * ⚠️ 2026-10-18 两条 Era 指令改变了推进链：
 *  - **重置阶段瞬穿**：从充能推进一次直接落在抽牌阶段（重置自动运行自动推进，
 *    停顿与动画由客户端播放节奏呈现，不占用阶段停留）；
 *  - **抽牌手动化**：推进**进入**抽牌阶段后必须点击我方卡组（`draw-deck`，
 *    发光动作按钮）完成抽牌 —— 未抽牌时服务端拒绝继续推进。
 */
export async function advancePhase(page: Page, expectPhase: string): Promise<void> {
  await page.getByTestId('advance').click();
  await expect.poll(() => phaseText(page)).toContain(`阶段 ${expectPhase}`);
  if (expectPhase === '抽牌') {
    await page.getByTestId('draw-deck').click();
    // 抽牌完成后动作按钮消失（drawnThisPhase = true）
    await expect(page.getByTestId('draw-deck')).toHaveCount(0, { timeout: 10_000 });
  }
}

/**
 * 在**当前行动方的回合**里走完「充能 → 推进到主要 → 出一张随从」。
 *
 * 攻击链路要用它造出**攻击方与靶子**，故只出**随从**（法术进法术区，不能攻击）。
 *
 * 每一步都是「按规则现场推算」而非硬编码卡名：挑支付得起的最便宜的一张，
 * 充能其余随从来凑费用。改卡池不会连带改测试。
 *
 * ⚠️ 前置：调用时该页面必须是行动方，且处于充能阶段。
 */
export async function playOneMinion(page: Page): Promise<void> {
  // ① 充能：逐张充能（D-112 排他选中），留一张随从准备出牌
  const charged = await chargeMinions(page);

  // ② 推进到主要阶段（六阶段不可跳过；重置阶段瞬穿自动推进、抽牌阶段需点击卡组
  //    —— 均为 Era 2026-10-18 指令）
  await advancePhase(page, '抽牌');
  await advancePhase(page, '主要');

  // ③ 出一张**随从**。抽牌阶段抽过牌，手牌序号已变，必须重读。
  const hand1 = await readHand(page);
  const costZone = await zoneCount(page, 'cost', 1);
  const chosen = hand1
    .filter((c) => c.kind === '随从')
    .filter((c) => c.cost <= costZone)
    .sort((a, b) => a.cost - b.cost)[0];
  expect(chosen, `费用区 ${costZone} 张（充能 ${charged}），应存在支付得起的随从`).toBeDefined();

  await pick(page, [chosen!.index]);
  await page.getByTestId('play').click();
  // 我方随从区在 ④ 排 —— B2 上下镜像，我方是后出现的那个
  await expect(page.getByTestId('slot-0').nth(1).locator('[data-testid="card"]')).toHaveCount(1, {
    timeout: 10_000,
  });
}
