/**
 * 390px 竖屏的对战桌（T-02 + 批次 0 发布前必修 issue #113 / #114）。
 *
 * 原来的问题：右侧日志列写的是 `hidden sm:flex`，于是在手机宽度下**整列消失** ——
 * 战报（谁打了谁、破坏了什么）在手机上看不到，玩家只能靠猜。
 *
 * 现在窄屏改为「日志」按钮展开的抽屉。这条用例钉三件事：
 * 1. 窄屏有入口按钮（而不是什么都没有）；
 * 2. 默认收起，点开后能看到日志内容；
 * 3. 能收起（抽屉是 fixed 覆盖整屏，关不掉就再也点不到桌面）。
 *
 * 桌面上日志列仍常驻（`sm:flex`），所以这里只在移动视口断言。
 *
 * 另外两条是本轮批次 0 的两个移动端缺陷（都会在 390px 下复现、桌面不出现）：
 * - **#113** 手牌固定宽 `w-16` + `shrink-0`，6 张就横溢出 32px，最后一张被裁；
 * - **#114** `notice` 提示条 `fixed top-16` 正压在回合数 / 阶段 / 计时那一行上，
 *   且顶栏不折字约束缺失，各 span 被压到文字内部折行。
 *
 * #114 有**两条**用例：一条测「提示条不压计时」（单人局 · 换牌阶段，这是唯一
 * 不会折行的状态），另一条测「顶栏段数最多」（BO3 双端局，`series` 在场）——
 * 后者才是原缺陷的现场，见文件末尾那条的注释。
 */

import { expect, test, type Page } from '@playwright/test';

import { handCount, startGame, startSoloGame } from './helpers.js';

const WAIT = Number(process.env.E2E_WAIT_MS ?? 15_000);

/**
 * 手机竖屏 + 触屏。
 *
 * `hasTouch` 不是为了点得动 —— 是为了让「手指横向滑动被当成拖牌」这个前提成立，
 * 也就是说我们是在**真实的触屏环境**下验证「不靠横向滚动也能看全手牌」。
 */
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true } as const;

/** 屏幕矩形（相对视口，一次 evaluate 取齐，避免分次取时的竞态）。 */
interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** 顶栏 / 提示条 / 计时的实测布局快照。 */
interface TableLayout {
  notice: Rect | null;
  clock: Rect | null;
  header: Rect | null;
  /** `header.scrollWidth - header.clientWidth` —— 横向溢出量。 */
  headerOverflow: number;
  /** header 的布局方式 —— 挤不下时应「整块换行」，而不是把字压折。 */
  headerFlexWrap: string;
  /** header 的每个直接 span：data-testid + clientHeight（折行会翻倍）+ 空白处理方式。 */
  spans: { id: string; h: number; ws: string }[];
}

/**
 * 一次 `page.evaluate` 取齐顶栏与提示条的几何信息。
 *
 * **必须一次取完**：提示条 4s 后自动消退，分两次 `boundingBox()` 会有竞态
 * （第二次可能返回 `null`，报出来的失败就成了「元素不见了」而不是真实问题）。
 *
 * 抽成公共 helper 而不是两条用例各写一份：`#114` 与「BO3 顶栏段数最多」这两条
 * 要的是同一份数据，抄两份的话以后加一段顶栏只会改到一处（本仓库已踩过多次）。
 */
async function readTableLayout(page: Page): Promise<TableLayout> {
  return page.evaluate(() => {
    const rect = (
      el: Element | null,
    ): { top: number; bottom: number; left: number; right: number } | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const header = document.querySelector('header');
    return {
      notice: rect(document.querySelector('[data-testid="notice"]')),
      clock: rect(document.querySelector('[data-testid="clock"]')),
      header: rect(header),
      headerOverflow: header ? header.scrollWidth - header.clientWidth : 0,
      headerFlexWrap: header ? getComputedStyle(header).flexWrap : '',
      spans: header
        ? Array.from(header.children)
            .filter((el) => el.tagName === 'SPAN')
            .map((el) => ({
              id: el.getAttribute('data-testid') ?? el.textContent?.slice(0, 8) ?? '?',
              h: (el as HTMLElement).clientHeight,
              ws: getComputedStyle(el).whiteSpace,
            }))
        : [],
    };
  });
}

test('390px 竖屏：日志不再消失，可展开 / 收起（T-02）', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  // 新手引导会盖住整屏 —— 本用例只看日志抽屉，预置成已看
  await page.addInitScript(() => {
    try {
      localStorage.setItem('fc.introSeen', '1');
    } catch {
      /* 忽略 */
    }
  });
  await page.goto('/');
  await expect(page.getByText('服务端已连接')).toBeVisible({ timeout: WAIT });
  await page.getByTestId('nickname').fill('Phone');

  await page.getByTestId('create-solo').click();
  await page.getByTestId('ready').click();
  await expect(page.getByTestId('turn')).toBeVisible({ timeout: WAIT });

  // ① 窄屏有入口，且默认收起（不能一上来就盖住半个桌面）
  await expect(page.getByTestId('log-toggle')).toBeVisible();
  await expect(page.getByTestId('log')).toBeHidden();

  // ② 展开 → 日志可见且有内容（开局必然写了「洗牌 / 起手」这类条目）
  await page.getByTestId('log-toggle').click();
  await expect(page.getByTestId('log')).toBeVisible();
  await expect(page.getByTestId('log')).not.toBeEmpty();

  // ③ 收起 → 回到桌面（抽屉关不掉的话，之后所有操作都会被它挡住）
  await page.getByTestId('log-close').click();
  await expect(page.getByTestId('log')).toBeHidden();
});

/**
 * #113：移动端手牌最后一张被裁切。
 *
 * ## 为什么必须用 6 张的那一侧
 *
 * 先手 5 张、后手 6 张（docs/16 §1）。390px 下手牌区内容宽约 372px，
 * 5×64 + 4×4 = 336 塞得下，6×64 + 5×4 = 404 才有 32px 溢出 ——
 * 用 5 张那一侧验，坏代码照样是绿的。
 *
 * ## 为什么不用「横向滚动」当解法
 *
 * 卡面上有 pointerdown 拖拽判定，手指横滑会被当成拖牌，实际滑不动；
 * 也没有任何「右边还有一张」的提示。所以判定标准是**不滚动就能看全**：
 * 每张卡都完整落在视口内，且手牌行的 `scrollWidth` 不超过 `clientWidth`。
 */
test('390px 竖屏：6 张手牌整排落在视口内、手牌行不横向溢出（issue #113）', async ({ browser }) => {
  // 保留换牌阶段：此刻手牌还没被换掉，先手 5 张 / 后手 6 张
  const { host, guest } = await startGame(browser, {
    skipMulligan: false,
    contextOptions: PHONE,
  });

  const pages = [host, guest];
  const counts = [await handCount(host), await handCount(guest)];
  const sixIndex = counts.indexOf(6);
  expect(
    sixIndex,
    `换牌阶段应为 5 / 6 张（先手 5、后手 6），实际 ${counts.join(' / ')}`,
  ).toBeGreaterThanOrEqual(0);
  const page = pages[sixIndex]!;

  const hand = page.getByTestId('hand');
  const cards = hand.locator('[data-testid="card"]');
  await expect(cards).toHaveCount(6);

  // ① 每张卡都完整落在视口内 —— 最后一张最容易被裁，但逐张断言才能定位是哪张
  for (let i = 0; i < 6; i++) {
    const box = await cards.nth(i).boundingBox();
    expect(box, `第 ${i + 1} 张手牌应有布局盒`).not.toBeNull();
    // 纵向可能被桌面容器裁（那是另一件事），这里只钉横向
    expect(box!.x, `第 ${i + 1} 张手牌左边界应在视口内`).toBeGreaterThanOrEqual(0);
    expect(
      box!.x + box!.width,
      `第 ${i + 1} 张手牌右边界应在视口内（不被裁切）`,
    ).toBeLessThanOrEqual(390);
    // 辅助断言：它确实被渲染在首屏，而不是整块滚到了别处
    await expect(cards.nth(i)).toBeInViewport();
  }

  // ② 卡宽不能靠「裁到看不见」来收敛 —— issue 单要求 6 张时每张 ≥ 56px
  const firstBox = await cards.first().boundingBox();
  expect(firstBox!.width, '6 张手牌时每张宽度应 ≥56px').toBeGreaterThanOrEqual(56);

  // ③ 手牌行本身没有横向溢出（常态靠自适应宽度，滚动只是极端张数的兜底）
  const overflow = await hand.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, `手牌行不应横向溢出（实测溢出 ${overflow}px）`).toBeLessThanOrEqual(1);

  // ④ 视觉提示不是「被裁掉一半的卡」—— 每张卡都在容器内
  const handBox = await hand.boundingBox();
  const lastBox = await cards.last().boundingBox();
  expect(lastBox!.x + lastBox!.width).toBeLessThanOrEqual(handBox!.x + handBox!.width + 1);

  await host.context().close();
  await guest.context().close();
});

/**
 * #114：顶栏提示条遮挡回合计时 + 移动端顶栏挤成折行。
 *
 * ## 提示条怎么稳定出现
 *
 * `notice` 是 4s 后自动消退的临时提示（`useRoom` 的 `setNotice` + 4s timer），
 * 点「人机对战」那条「已开人机房」到进桌很可能已经过期。改用**刷新自动重连**：
 * `room:reconnect` 的 ack 里会重新 `setNotice('已自动重连到原房间')`，
 * 于是「提示条 + 顶栏同时在场」是确定出现的，不依赖操作快慢。
 *
 * 换牌阶段开局（`skipMulligan: false`）只是为了让对局停在原地，不跟 AI 抢时序。
 *
 * ## 为什么两个矩形要一次 evaluate 取完
 *
 * 提示条 4s 后就没了，分两次 `boundingBox()` 取会存在竞态（第二次返回 null）。
 */
test('390px 竖屏：提示条不压住回合计时，顶栏各段不折字（issue #114）', async ({ browser }) => {
  const { page } = await startSoloGame(browser, {
    skipMulligan: false,
    contextOptions: PHONE,
  });

  await page.reload();
  await expect(page.getByTestId('notice')).toBeVisible({ timeout: WAIT });

  let snap: TableLayout | null = null;
  await expect
    .poll(
      async () => {
        snap = await readTableLayout(page);
        return snap.notice !== null && snap.clock !== null && snap.header !== null;
      },
      { timeout: WAIT, message: '提示条与顶栏应同时在场（重连提示 + 回合计时）' },
    )
    .toBe(true);

  const { notice, clock, headerOverflow, headerFlexWrap, spans } = snap as unknown as TableLayout;

  /*
   * ① 顶栏每段都**不拆词**（`white-space: nowrap`）。
   *
   * 这条是「挤成折行」的直接原因：`flex` 子项默认可收缩，没有 nowrap 时浏览器会
   * 优先在**文字内部**换行（「开 局」「阶段 换 / 牌」），而不是把整段挪到下一行。
   */
  for (const s of spans) {
    expect(s.ws, `顶栏「${s.id}」允许在文字内部折行（white-space=${s.ws}）`).toBe('nowrap');
  }

  // ② 顶栏各段实测也确实是单行（text-xs 行高 16px；折行会变成 32px+）
  for (const s of spans) {
    expect(s.h, `顶栏「${s.id}」被压成折行（高度 ${s.h}px，单行应 ≤20px）`).toBeLessThanOrEqual(20);
  }

  // ③ 真挤不下时整块换行，而不是继续压缩每一段
  expect(headerFlexWrap, '顶栏应允许整块换行（flex-wrap）').toBe('wrap');

  // ④ 顶栏不产生横向溢出
  expect(headerOverflow, '顶栏不应横向溢出').toBeLessThanOrEqual(1);

  // ⑤ 提示条与计时**不相交**（原来 fixed top-16 正好压在这一行上）
  const disjoint =
    notice!.bottom <= clock!.top ||
    clock!.bottom <= notice!.top ||
    notice!.right <= clock!.left ||
    clock!.right <= notice!.left;
  expect(
    disjoint,
    `提示条 [${notice!.top}~${notice!.bottom}] 与计时 [${clock!.top}~${clock!.bottom}] 重叠`,
  ).toBe(true);

  // ⑥ 提示条独占一行且排在顶栏**上方**（在流内，不再 fixed 覆盖）
  expect(
    notice!.bottom,
    `提示条底边 ${notice!.bottom} 应不高于计时顶边 ${clock!.top}（提示条在顶栏之上）`,
  ).toBeLessThanOrEqual(clock!.top + 1);

  // ⑦ 计时文案仍完整（挪动布局不能把内容弄丢）
  await expect(page.getByTestId('clock')).toContainText('计时');

  await page.context().close();
});

/**
 * #114 补测：顶栏**段数最多**的状态（BO3 的比分段在场）。
 *
 * ## 为什么在已经有 #114 用例的情况下还要一条
 *
 * 单人对局 · 换牌阶段是这个缺陷**唯一不复发**的状态：那 4 段（回合 / 阶段 / 计时 /
 * 换牌确认状态）在 390px 下恰好放得下（各段总宽只比可用宽度小约 10px），
 * 旧代码在这一屏**并没有真的折行**。也就是说，只测那个状态的话，将来谁把
 * `whitespace-nowrap` 从几个 span 上删掉，用例都不会红 —— 这是 QA 复验时挑出的覆盖盲区。
 *
 * 真正的原缺陷现场是**段数更多 / 文案更长**的时候：
 * - BO3 会给顶栏追加「第 1 局 · 比分 0 : 0」（`series`）；
 * - 联机对手断线会再追加「对手已断线（60 秒内可重连）」（`foe-offline`）。
 *
 * QA 用探针在 390px 实测：旧代码在这些状态下各段 `clientHeight` 是 **32px（两行）**，
 * 新代码 **16px（单行）**。所以这里用 BO3 双端局把「最容易压垮顶栏」的状态固化下来。
 *
 * 断言口径与上一条**完全相同，不放宽** —— 重复这几条不是冗余，
 * 而是要把「约束必须在场」钉在最容易被压垮的那个状态上。
 */
test('390px 竖屏：BO3 双端局顶栏段数最多时，每段仍是单行不折字（issue #114 补测）', async ({
  browser,
}) => {
  // 双端都开成 390×844；`format: 'bo3'` 让顶栏多一个 `series` 段
  const { host, guest } = await startGame(browser, {
    format: 'bo3',
    skipMulligan: false,
    contextOptions: PHONE,
  });

  // 两端都量：谁先手由服务端掷骰决定，顶栏结构相同，顺带覆盖两端的成长资源文案
  for (const page of [host, guest]) {
    // 开局事件是**逐条播放**的，顶栏段数在事件到齐前会变化 —— 等 `series` 出现再量
    await expect(page.getByTestId('series')).toBeVisible({ timeout: WAIT });

    const { header, headerOverflow, headerFlexWrap, spans } = await readTableLayout(page);
    const ids = spans.map((s) => s.id);

    /*
     * ⓪ 前提：`series` 段确实在场。
     *
     * 少了这一条，用例可能因为 BO3 没生效而悄悄退化成「和上一条测同一个状态」，
     * 看着绿、其实什么都没钉住。
     */
    expect(header, '顶栏应已渲染').not.toBeNull();
    expect(ids, '顶栏应含 BO3 比分段（series），否则这条用例退化成了上一条').toContain('series');

    // ① 每段都不在文字内部折行（与 #114 同口径）
    for (const s of spans) {
      expect(s.ws, `顶栏「${s.id}」允许在文字内部折行（white-space=${s.ws}）`).toBe('nowrap');
    }

    // ② 每段实测单行（text-xs 行高 16px；旧代码在这个状态下是 32px）
    for (const s of spans) {
      expect(s.h, `顶栏「${s.id}」被压成折行（高度 ${s.h}px，单行应 ≤20px）`).toBeLessThanOrEqual(
        20,
      );
    }

    // ③ 挤不下时整块换行（header 自己可以变两行，但不能把每一段压折）
    expect(headerFlexWrap, '顶栏应允许整块换行（flex-wrap）').toBe('wrap');

    // ④ 不横向溢出
    expect(headerOverflow, '顶栏不应横向溢出').toBeLessThanOrEqual(1);
  }

  await host.context().close();
  await guest.context().close();
});
