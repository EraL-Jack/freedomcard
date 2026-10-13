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

/** 选中手牌中的若干张（多选，索引基于调用时刻的手牌快照）。 */
export async function pick(page: Page, indices: readonly number[]): Promise<void> {
  const cards = page.getByTestId('hand').locator('[data-testid="card"]');
  for (const i of indices) await cards.nth(i).click();
}

/**
 * 区域显示的张数。
 *
 * ⚠️ B2 布局是**上下镜像**的：对方与我都各有同名区域，故必须指定第几个
 * （`zone-cost` 的 0 = 对方，1 = 我方第 ④ 排，2 = 我方第 ⑤ 排重复项）。
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
