import { expect, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * E2E 公共辅助。
 *
 * 单独成文件是因为两条 spec 都要「建房 → 加入 → 双方准备 → 开局」，
 * 且都要读对局事实（手牌 / 区域张数 / 当前行动方）—— 重复写两份会在
 * 界面演进时改漏一处。
 */

/**
 * 等界面就绪的上限。
 *
 * 本地回环一步不到 1s，10~15s 很宽松；但走公网隧道时单步要 3~10s（实测日本节点 4 条用例共 32.6s），
 * 原来的 10s 会卡在边界 —— 2026-10-20 公网全量就出现过「19 通过、1 条偶发超时」。
 * 公网验证时用 `E2E_WAIT_MS=30000` 覆盖，本地保持默认。
 */
const WAIT = Number(process.env.E2E_WAIT_MS ?? 15_000);

/** 开一个已连上服务端的客户端页面。 */
export async function newClient(
  browser: Browser,
  nickname: string,
  /**
   * 额外的 context 选项 —— 目前只有视口用得上（D-256 的「提示是否在首屏内」必须窄屏才测得出来）。
   * 放在这里而不是让 spec 自己 `newContext`：引导预置那段逻辑抄第二份就会漏（D-255 踩过）。
   */
  contextOptions: Parameters<Browser['newContext']>[0] = {},
): Promise<Page> {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  /*
   * 新手引导（P-03）默认标记为「已看」。
   *
   * 它是 `fixed inset-0` 的模态浮层，会挡住对战桌的每一次点击 —— 全量 E2E
   * 都会死在第一步「点充能没反应」。引导本身的出现/消失由 `guide.spec.ts`
   * 单独验（那条用例不走本函数，自己建 context）。
   */
  await page.addInitScript(() => {
    try {
      localStorage.setItem('fc.introSeen', '1');
    } catch {
      // 忽略：没有 localStorage 时引导会自己兜底成不弹（见 TableScreen）
    }
  });
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: WAIT });
  await page.getByTestId('nickname').fill(nickname);
  return page;
}

/**
 * 建房 + 加入 + 双方准备，返回两个已开局的页面。
 *
 * `hostDeck` / `guestDeck` 是**卡组选择值**（D-184）：`basic-blade|basic-frost|basic-star`
 * 或 localStorage 里的自建卡组 id。建房与加入共用同一个下拉 `deck-choice`，
 * 阵营那套选择已经没有了（ADR-0042）。
 *
 * ## 为什么默认把换牌阶段跳过去（D-259）
 *
 * 换牌现在是**游戏开始之前**的独立阶段（`phase === 'mulligan'`），开局即停在那里，
 * 双方都提交才进第一回合。绝大多数用例只关心「进对局之后」的事，卡在换牌阶段
 * 会让它们全部超时 —— 故默认替双方点「不换牌」。
 *
 * 专门测换牌的用例传 `skipMulligan: false`，自己掌控这个阶段。
 */
export async function startGame(
  browser: Browser,
  opts: {
    format?: 'bo1' | 'bo3';
    hostDeck?: string;
    guestDeck?: string;
    /** 默认 `true`：替双方跳过开局换牌。传 `false` 保留换牌阶段给用例自己操作。 */
    skipMulligan?: boolean;
    /**
     * 额外 context 选项（视口 / 触屏）—— 移动端布局用例要把**双方**都开成手机。
     * 不传时沿用 Playwright 项目默认（桌面 1280×720）。
     */
    contextOptions?: Parameters<Browser['newContext']>[0];
  } = {},
): Promise<{ host: Page; guest: Page; code: string }> {
  const ctx = opts.contextOptions ?? {};
  const host = await newClient(browser, 'Host', ctx);
  // D-132：赛制在**建房**时选（BO1 默认）。
  if (opts.format) await host.getByTestId('format').selectOption(opts.format);
  if (opts.hostDeck) await host.getByTestId('deck-choice').selectOption(opts.hostDeck);
  await host.getByTestId('create').click();
  const code = ((await host.getByTestId('room-code').textContent()) ?? '').trim();

  const guest = await newClient(browser, 'Guest', ctx);
  if (opts.guestDeck) await guest.getByTestId('deck-choice').selectOption(opts.guestDeck);
  await guest.getByTestId('code').fill(code);
  await guest.getByTestId('join').click();
  await expect(guest.getByTestId('ready')).toBeVisible({ timeout: WAIT });

  // 双方准备 → 服务端建立对局（ADR-0019）
  await host.getByTestId('ready').click();
  await guest.getByTestId('ready').click();

  await expect(host.getByTestId('turn')).toBeVisible({ timeout: WAIT });
  await expect(guest.getByTestId('turn')).toBeVisible({ timeout: WAIT });

  if (opts.skipMulligan !== false) await skipMulligan([host, guest]);

  return { host, guest, code };
}

/**
 * 开一局**人机对战**（D-242），返回已进桌的页面。
 *
 * 人机局的座位与联机不同：AI 在**建房时**就坐下并恒为「已准备」（房间代码在
 * `room.ts` 的 `solo` 分支），所以这里只有「建房 → 准备」两步，没有对手页面。
 *
 * `skipMulligan` 默认 `true`：绝大多数用例只关心「进对局之后」的阶段。
 * 要验 **D-262 的回归点**（人机局的开局换牌阶段是否真的存在）的用例传 `false` ——
 * 换牌阶段曾被 `advanceOnce` 当成「结束阶段之后」整段推走，玩家从没见过这个界面。
 *
 * 注意玩家只需点**一次**「不换牌」：AI 会自己提交（`decideAiMove` 的换牌分支），
 * 不是「两个页面各点一次」。
 */
export async function startSoloGame(
  browser: Browser,
  opts: {
    skipMulligan?: boolean;
    deck?: string;
    /** 额外 context 选项（视口 / 触屏）—— 移动端布局用例用它开成手机。 */
    contextOptions?: Parameters<Browser['newContext']>[0];
  } = {},
): Promise<{ page: Page }> {
  const page = await newClient(browser, 'Solo', opts.contextOptions ?? {});
  if (opts.deck) await page.getByTestId('deck-choice').selectOption(opts.deck);
  await page.getByTestId('create-solo').click();
  await page.getByTestId('ready').click();
  await expect(page.getByTestId('turn')).toBeVisible({ timeout: WAIT });
  if (opts.skipMulligan !== false) {
    await expect(page.getByTestId('mulligan-skip')).toBeVisible({ timeout: WAIT });
    await page.getByTestId('mulligan-skip').click();
  }
  return { page };
}

/**
 * 替双方点「不换牌」，把开局换牌阶段推过去（D-259）。
 * 换牌是**开局前的独立阶段**：双方各自提交一次才进第一回合（服务端发 `mulligan:closed`）。
 * 所以这里必须两边都点 —— 只点一边，阶段会一直停着，后续所有「你的回合」断言都会超时。
 *
 * 只关心「进对局之后」的用例都用它；要测换牌本身的用例传 `skipMulligan: false` 自己操作。
 */
export async function skipMulligan(pages: readonly Page[]): Promise<void> {
  for (const p of pages) {
    const skip = p.getByTestId('mulligan-skip');
    await expect(skip, '「不换牌」按钮应可见 —— 开局应停在换牌阶段').toBeVisible({ timeout: WAIT });
    await skip.click();
  }
  await expect.poll(() => phaseText(pages[0]!), { timeout: WAIT }).not.toContain('阶段 换牌');
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
 *
 * `keep` = **要留几张随从**（默认 1）。只验法术的用例传 0 —— 随从对它没用，
 * 全部充进费用区才能把 `maxCost` 档位抬上去（issue #149）。
 */
export async function chargeMinions(page: Page, keep = 1): Promise<number> {
  // 从**当前**费用区张数起算（调用前可能已有拖拽充能，drag.spec 2026-10-18）。
  // 返回充能完成后费用区的总张数。
  //
  // ⚠️ 不按「+1 张」做算术断言：充能收入是逐条播放事件的，可能在测试开始操作之后
  // 才到达。故每张充能只断言「费用区张数比操作前多」—— 天然抗播放延迟。
  //
  // ⚠️ **留下最便宜的那张随从**（按实际支付额），不是「随便留一张」：
  // 第 1 回合 maxCost = 1，若留下 5 费大哥（支付 4）就出不了，测试会误报。
  let total = await zoneCount(page, 'cost', 1);
  for (;;) {
    const hand = await readHand(page);
    const minions = hand.filter((c) => c.kind === '随从');
    if (minions.length <= keep) break; // 留够 `keep` 张随从；极端牌序（随从不够）则不再充
    const cheapest = [...minions].sort((a, b) => payOf(a) - payOf(b))[0]!;
    const target = minions.find((c) => c.index !== cheapest.index);
    if (!target) break;
    const before = await zoneCount(page, 'cost', 1);
    await pick(page, [target.index]);
    await page.getByTestId('charge').click();
    await expect.poll(() => zoneCount(page, 'cost', 1), { timeout: 10_000 }).toBeGreaterThan(before);
    total = await zoneCount(page, 'cost', 1);
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
 * ⚠️ 取专属的 `zone-count` 节点，不再从区域文本里捞「最后一个数字」——
 * 费用区现在带「本回合 已用/上限」徽标（docs/16 §3.3），会把数字解析带偏。
 */
export async function zoneCount(page: Page, zone: string, nth = 0): Promise<number> {
  const node = page.getByTestId(`zone-${zone}`).nth(nth).getByTestId('zone-count');
  const text = ((await node.innerText()) ?? '').trim();
  return Number(text);
}

/**
 * 我方手牌张数（只数节点，不解析内容 —— 比 `readHand` 快，也抗「卡面还在渲染」）。
 *
 * 换牌用例要用它做前置判人：起手张数是**先/后攻的唯一界面可见判据**
 * （先手 5 / 后手 6，docs/16 §1）。`activePage` 在换牌阶段帮不上忙 ——
 * 那时两个页面都不显示「你的回合」，因为换牌不属于任何回合（D-259）。
 */
export async function handCount(page: Page): Promise<number> {
  return page.getByTestId('hand').locator('[data-testid="card"]').count();
}

/** 当前回合数（从「第 N 回合」解析）。 */export async function turnNo(page: Page): Promise<number> {
  const text = (await page.getByTestId('turn').innerText()) ?? '';
  return Number(/(\d+)/.exec(text)?.[1] ?? NaN);
}

/**
 * 长按一张卡打开详情浮层（D-261 / issue #87）。
 *
 * 原来右上角那个 16px 的「?」按钮已删除 —— Era 反馈「太难点了」。
 * 现在的入口是：长按卡面（触屏/鼠标都行）、右键、选中手牌后的「详情」按钮。
 * 阈值 400ms，这里按 500ms 保证计时器真的触发。
 *
 * ⚠️ 长按触发后组件会压掉随后的 click，所以 `mouse.up()` 之后**不能**再期待选中状态变化。
 */
export async function longPressCard(page: Page, target: Locator): Promise<void> {
  await target.hover();
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect(page.getByTestId('card-detail-overlay')).toBeVisible({ timeout: 5_000 });
}

/** 当前阶段名（从 header 的「阶段 X」解析）。 */
export async function phaseText(page: Page): Promise<string> {
  return ((await page.locator('header').innerText()) ?? '').trim();
}

/**
 * 推进一个阶段并断言到位。
 *
 * ⚠️ 2026-10-18/19 三条 Era 指令改变了推进链：
 *  - **重置阶段瞬穿**：从充能推进一次直接落在抽牌阶段（重置自动运行自动推进，
 *    停顿与动画由客户端播放节奏呈现，不占用阶段停留）；
 *  - **抽牌手动化**：推进**进入**抽牌阶段后必须点击我方卡组（`draw-deck`，
 *    发光动作按钮）完成抽牌 —— 未抽牌时服务端拒绝继续推进；
 *  - **抽完自动推进**（2026-10-19）：点完卡组直接落在主要阶段，不用再点推进。
 */
export async function advancePhase(page: Page, expectPhase: string): Promise<void> {
  await page.getByTestId('advance').click();
  await expect.poll(() => phaseText(page)).toContain(`阶段 ${expectPhase}`);
  if (expectPhase === '抽牌') {
    await page.getByTestId('draw-deck').click();
    // 抽牌完成后自动推进到主要阶段（Era 2026-10-19）；动作按钮随阶段离开而消失
    await expect.poll(() => phaseText(page), { timeout: 10_000 }).toContain('阶段 主要');
    await expect(page.getByTestId('draw-deck')).toHaveCount(0);
  }
}

/** 当前回合费用使用情况（docs/16 §3.3）—— 从费用区徽标「本回合 已用/上限」解析。 */
export async function costBudget(page: Page): Promise<{ used: number; max: number }> {
  const text = (await page.getByTestId('cost-usage').innerText().catch(() => '')) ?? '';
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  return m ? { used: Number(m[1]), max: Number(m[2]) } : { used: 0, max: 1 };
}

/**
 * 一张手牌的实际支付张数。
 *
 * D-232（Era 2026-10-21）：局内卡面**已经显示实际值**（`costToPay`），
 * 所以这里不能再减 1 —— 否则会二次打折。
 * D-313（#164）之后 `costToPay(def) === def.cost`，这个函数就是透传卡面值。
 */
export function payOf(card: HandCard): number {
  return card.cost;
}

/** 当前回合剩余可支付的张数。 */
export async function costRemaining(page: Page): Promise<number> {
  const b = await costBudget(page);
  return Math.max(0, b.max - b.used);
}

/**
 * 把「登场效果引出的待定选择」全部放弃掉。
 *
 * 部分随从登场即要求选择目标（如霜律学徒 / 炎刃老兵 / 卫士），
 * 不处理会一直挂着 `pendingChoice`，后续推进阶段会被引擎拒绝
 * （ADR-0023 §2 全局守卫）。E2E 只关心链路是否闭合，不关心选哪个目标，
 * 故统一点「放弃」；多选类会连续弹出，循环处理。
 */
export async function settleChoices(page: Page): Promise<void> {
  // 事件播放队列有节奏，待定选择可能晚几百毫秒才到达客户端
  await page.waitForTimeout(800);
  for (let i = 0; i < 5; i++) {
    const overlay = page.getByTestId('choice-overlay');
    if (!(await overlay.isVisible().catch(() => false))) return;
    await overlay.getByTestId('choice-pass').click();
    await page.waitForTimeout(200);
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

  // ② 推进到主要阶段（六阶段不可跳过；重置阶段瞬穿、抽牌手动点击且抽完自动推进
  //    —— 均为 Era 2026-10-18/19 指令；`advancePhase(p,'抽牌')` 走完已落在主要）
  await advancePhase(page, '抽牌');

  // ③ 出一张**随从**。抽牌阶段抽过牌，手牌序号已变，必须重读。
  //    docs/16 §3.3：还要满足本回合 maxCost（各自回合数 → 1/3/5/10）。
  const hand1 = await readHand(page);
  const costZone = await zoneCount(page, 'cost', 1);
  const budget = await costRemaining(page);
  const chosen = hand1
    .filter((c) => c.kind === '随从')
    .filter((c) => payOf(c) <= costZone && payOf(c) <= budget)
    .sort((a, b) => payOf(a) - payOf(b))[0];
  expect(
    chosen,
    `费用区 ${costZone} 张（充能 ${charged}），本回合剩余额度 ${budget}，应存在支付得起的随从`,
  ).toBeDefined();

  await pick(page, [chosen!.index]);
  await commitPlay(page);
  // 我方随从区在 ④ 排 —— B2 上下镜像，我方是后出现的那个
  await expect(page.getByTestId('slot-0').nth(1).locator('[data-testid="card"]')).toHaveCount(1, {
    timeout: 10_000,
  });
  // 登场效果可能引出待定选择（霜律学徒 / 卫士 / 老兵…）—— 放掉，避免卡住后续推进
  await settleChoices(page);
}

/**
 * 若弹出「选费用卡」面板就确认（预选已是旧行为：按费用区顺序取前 N 张）。
 *
 * D-257 起费用支付变成**可选**的第二步：费用区比该付的多时弹面板。
 * 拖拽出牌（`drag.spec`）也走同一条规则 —— 所以这条不能只写在 `commitPlay` 里。
 *
 * 1.5s 判定的是「分支存不存在」，不是等慢操作；等久了会把真失败吞成假绿。
 */
export async function confirmPay(page: Page): Promise<boolean> {
  const needPay = await page
    .getByTestId('pay-confirm')
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (needPay) await page.getByTestId('pay-confirm').click();
  return needPay;
}

/**
 * 完成一次出牌（D-257 起出牌变成两段/三段）。
 *
 * 顺序：点「出牌」→（随从）点我方某一格选位置 →（费用区比该付的多时）确认支付。
 *
 * 抽成 helper 的原因：这条链在 `playOneMinion` 与 `turn.spec` 里各写一遍，
 * 而 D-256 已经证明「同一份逻辑抄两份、只改一处」会静默失效 ——
 * 漏掉「选位置」的表现是「点了出牌，卡还在手上」，看起来像功能坏了。
 *
 * 两处 `waitFor` 的超时都只给 1.5s：它们判断的是**分支存不存在**（是不是随从 /
 * 费用区有没有多余可选），不是「等某个慢操作完成」。等久了会把真实失败吞成假绿。
 */
export async function commitPlay(page: Page, opts: { slot?: number } = {}): Promise<void> {
  await page.getByTestId('play').click();
  const placing = await page
    .getByTestId('placing-hint')
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (placing) await page.getByTestId(`slot-${opts.slot ?? 0}`).nth(1).click();
  await confirmPay(page);
}
