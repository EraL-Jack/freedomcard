import { expect, test } from '@playwright/test';

import { phaseText, pick, readHand, startSoloGame, turnNo } from './helpers.js';

/**
 * 人机对战（D-242）的开局路径。
 *
 * ## 为什么单独一个 spec
 *
 * 联机对局的 E2E 走 `startGame`（建房 + 加入 + 双方准备），而人机局是
 * 「建房即坐入 AI、AI 恒为已准备」，**开局链路不同**（`room.ts` 的 `solo` 分支）。
 * D-262 之前这条路径零覆盖，于是出现了一个联机永远测不出的 bug：
 * 人机局没有换牌阶段，开局直接跳到「第 2 回合 · 充能」。
 */

test('人机房开局停在换牌阶段，不是直接开打（D-262）', async ({ browser }) => {
  const { page } = await startSoloGame(browser, { skipMulligan: false });

  // ① 回合数显示「开局」—— 换牌阶段不属于任何回合
  await expect(page.getByTestId('turn')).toContainText('开局', { timeout: 15_000 });
  // ② 阶段进度条要多一枚「换牌」，否则六个格全灰、玩家以为没开始
  await expect(page.getByTestId('phase-track')).toContainText('换牌');
  // ③ 玩家有「不换牌」入口（按钮可见即代表这个阶段真的开着）
  await expect(page.getByTestId('mulligan-skip')).toBeVisible({ timeout: 15_000 });
  // ④ AI 必须**自己**提交过 —— 否则玩家要干等 30 秒换牌超时兜底
  await expect(page.getByTestId('log')).toContainText('完成换牌', { timeout: 15_000 });
});

test('点「不换牌」后进第 1 回合，而不是第 2 回合（D-262 回归点）', async ({ browser }) => {
  const { page } = await startSoloGame(browser, { skipMulligan: false });
  await page.getByTestId('mulligan-skip').click({ timeout: 15_000 });

  /*
   * 这里断言的是 **1**，不是「比之前大」。
   *
   * 修之前的表现正是「点完（或根本没机会点）直接显示第 2 回合」：
   * `advanceOnce` 用 `PHASE_ORDER.indexOf('mulligan')` = -1 落进了
   * 「结束阶段之后 → 进入下一回合」分支，把第一回合整个吃掉了。
   * 所以这条用例必须钉死具体回合号 —— 写成 `toBeGreaterThan(0)` 就抓不到。
   */
  await expect.poll(() => turnNo(page), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => phaseText(page), { timeout: 15_000 }).toContain('充能');
});

/**
 * D-267 / issue #99：换牌阶段的倒计时必须**可见**。
 *
 * 原来 `snapshot.turnDeadline` 取的是回合计时器的截止时刻，而换牌阶段那个计时器是
 * `clear` 状态（值 0）→ 顶栏「计时 —」。Era 的原话：「倒计时要显示在桌面上，
 * 目前看倒计时是 -」。这条钉两件事：数字要出来，且要说明「到点会自动开局」。
 *
 * ⚠️ 只断言「不是 —」是不够的：`remain` 为 0 时也会显示 `0s`。
 * 所以正则要求 ≥1 位数字且带 `s`，并在文案里确认「到点自动不换牌」——
 * 后者是玩家得知「我可以什么都不点」的唯一途径。
 */
test('换牌阶段桌面有倒计时，并写明到点自动开局（D-267）', async ({ browser }) => {
  const { page } = await startSoloGame(browser, { skipMulligan: false });

  await expect(page.getByTestId('clock'), '换牌阶段顶栏应显示剩余秒数').toHaveText(/计时 \d+s/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('phase-hint')).toContainText('剩余');
  await expect(page.getByTestId('phase-hint')).toContainText('到点自动不换牌开局');
});

/**
 * D-268 / issue #101：**回合边界的中间帧不许被当成真局面**。
 *
 * Era 的原话：「充能阶段的提示在切换回合之前显示了」。
 *
 * 根因不在引擎 —— 回合边界在事件流里就是两条（`phase:changed(… → charge)` +
 * `turn:changed`），是客户端**逐条播放 + 每相位停 750ms** 把中间那一帧画了出来：
 * 阶段已经是下一回合的充能、`activeSeat` 还是自己，于是结束回合的人看到
 * 「你的回合 · 充能阶段：点手牌里的随从…」，愣一下才交棒给对手。
 *
 * ## 为什么这样断言
 *
 * 单点断言会漏：坏状态下只有 750ms 是错的，`toHaveText` 可能正好错过，好状态下
 * 也不该依赖时序。所以这里**连续采样**整个交棒过程，只钉一条不变量：
 * 任何一帧都不得同时出现「你的回合」与「充能阶段」的指引 ——
 * 这个组合从未真实存在过。坏代码必然在窗口内被采到，好代码一帧都不违例。
 */
test('结束回合时不给「你的回合 + 充能阶段」的错误指引（D-268）', async ({ browser }) => {
  const { page } = await startSoloGame(browser);

  // 先后手由 seed 决定，不能假设玩家先手 —— 等到真的轮到我再动手
  await expect(page.getByTestId('turn-label'), '应轮到玩家行动').toHaveText('你的回合', {
    timeout: 15_000,
  });

  const sample = (): Promise<{ label: string; phase: string; hint: string }> =>
    page.evaluate(() => {
      const text = (id: string): string =>
        document.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
      return { label: text('turn-label'), phase: text('phase'), hint: text('phase-hint') };
    });

  await expect(page.getByTestId('phase'), '开局应停在充能阶段').toContainText('充能');
  await page.getByTestId('end-turn').click();

  const samples: { label: string; phase: string; hint: string }[] = [];
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    const s = await sample();
    samples.push(s);
    // 交棒完成即停止 —— 再往后「真的是我」的充能阶段不算违例
    if (s.label === '对手回合') break;
    await page.waitForTimeout(40);
  }

  // ① 交棒必须真的发生过，否则后面的断言是空验证
  expect(
    samples.at(-1)?.label,
    `回合应已交给电脑，实际采样：${JSON.stringify(samples.slice(-3))}`,
  ).toBe('对手回合');

  /*
   * ② 先定位「阶段第一次离开充能、又回到充能」的那一帧 —— 那是新回合的起点。
   *
   * ⚠️ 不能只断言「不得同时出现 你的回合 + 充能阶段」：**我自己的充能阶段本来就是
   * 这个组合**（合法的回合起点），照字面断言会把正确行为判成错误（首版就是这么翻的车）。
   * 违例只在「离开过充能之后又回到充能、席位却还没换」时成立 —— 那个局面从未真实存在。
   */
  const leftCharge = samples.findIndex((s) => !s.phase.includes('充能'));
  expect(leftCharge, '应观察到阶段离开充能（战斗 / 结束阶段）').toBeGreaterThan(-1);
  const backToCharge = samples.findIndex((s, i) => i > leftCharge && s.phase.includes('充能'));
  expect(backToCharge, '应观察到阶段回到充能（新回合起点）').toBeGreaterThan(-1);

  const lies = samples
    .slice(backToCharge)
    .filter((s) => s.label === '你的回合' && s.hint.includes('充能阶段'));
  expect(lies, '交棒前的那 750ms 不应给出「你的回合 · 充能阶段」的指引').toEqual([]);
});

/**
 * #136（Era 2026-10-22 拍板「对手只记『抽了 1 张』」）：**战报不许比桌面更公开**。
 *
 * 桌面上的对手手牌区只写「对方手牌 N 张」，右侧战报却在逐张念卡名
 * （「电脑 抽到 霜律终裁」）—— 同一份信息一半隐藏一半公开，玩家无法判断
 * 哪条规则是真的。卡池只有 45 张、同名上限 3，知道对手刚抽到什么就等于
 * 知道下回合能不能让他铺满冻结随从 —— 这不是「多知道一点」，是**信息泄露**。
 *
 * ## 为什么这条用例能在开局就断言，不用先抽牌
 *
 * 起手是**逐张** `card:moved(deck → hand)` 发的（`startRule` 的 ⑤ 段，
 * 先手 5 / 后手 6），所以进桌那一刻战报里就已经有双方的抽牌行了 ——
 * 不需要刻意推进到抽牌阶段，断言更稳（没有「推进失败导致空战报」的假绿风险）。
 *
 * ## 为什么这样断言
 *
 * 只断言「不含 电脑 抽到」会**假绿**：万一抽牌行整段没渲染出来，
 * 空字符串同样不含它。所以先用「电脑 抽了 1 张」证明这一批抽牌行真的在页面上，
 * 再否认卡名 —— 顺序不能反。
 *
 * ## 充能是同源的第二个漏洞（Era 2026-10-21 23:47「充能那一行请一并收口」）
 *
 * 充能 = `deck → cost`，和抽牌一样是「牌库顶 → 私有区」。回合开始的强制收入
 * 就是两张（docs/16 §2 充能①，`COST_INCOME_PER_TURN = 2`），所以电脑一进充能阶段
 * 就会刷出两条 —— 修之前它们逐条念卡名，同样是信息泄露。
 *
 * ⚠️ 这里的「泄露」不是「桌面上看不到」：对手费用区可以**点开浮窗**看到卡面
 * （`ZoneBox content='float'`）。区别是推送方式 —— 浮窗要主动点，战报是自动刷的。
 * 依据是 Era 的明写口径，而不是「谁更公开」这个类比。
 */
test('人机局：电脑抽牌只记「抽了 1 张」，自己的抽牌仍显示卡名（#136）', async ({ browser }) => {
  // 这条用例要跨两个回合（自己充能一次 + 电脑的充能阶段），默认 30s 不够
  test.setTimeout(120_000);
  const { page } = await startSoloGame(browser);
  const log = page.getByTestId('log');

  // ① 电脑的抽牌行确实存在（且有节奏感，没被整行吞掉）
  await expect(log).toContainText('电脑 抽了 1 张', { timeout: 15_000 });

  // ② 核心口径：电脑的抽牌行不得出现卡名
  const logText = await log.innerText();
  expect(logText, '战报不得念出对手抽到的卡名（issue #136）').not.toContain('电脑 抽到');

  // ③ 自己的抽牌行仍要念卡名 —— 而且这个卡名必须真的在**自己手牌**里。
  //
  //    只断言「有一行以 Solo 抽到 开头」仍然偏松，所以把名字取出来跟 DOM 手牌
  //    交叉验证：起手刚发完、什么牌都还没出，抽到的牌就躺在手牌区。
  //    这样「自己 抽到 1 张」这种退化（把卡名也替换成张数）会被当场抓住。
  const myDraws = (await log.locator('p').allInnerTexts())
    .map((t) => t.trim())
    .filter((t) => t.startsWith('Solo 抽到 '))
    .map((t) => t.slice('Solo 抽到 '.length).trim());
  expect(
    myDraws.length,
    `战报里应有自己的抽牌行，实测：${JSON.stringify(logText)}`,
  ).toBeGreaterThan(0);
  expect(myDraws, '自己的抽牌行不该退化成「1 张」').not.toContain('1 张');

  const handNames = (await readHand(page)).map((c) => c.name);
  for (const name of myDraws) {
    expect(handNames, `自己的抽牌行「抽到 ${name}」应真的在这张牌手里`).toContain(name);
  }

  /*
   * ④ 自己充能仍念卡名 —— 反向守卫「别把隐藏扩大成对手所有进费用区的都不念」。
   *
   * 先后手由 seed 决定（`activePage` 的注释解释过为什么不能假设玩家先手），
   * 所以这里等**自己的充能阶段**，不假设它就在开局。电脑先手时要等它打完整轮。
   */
  await expect
    .poll(
      async () => {
        const label = (await page.getByTestId('turn-label').innerText().catch(() => '')).trim();
        const phase = await phaseText(page);
        return label === '你的回合' && phase.includes('充能');
      },
      { timeout: 45_000, message: '应等到自己的充能阶段' },
    )
    .toBe(true);

  const myHand = await readHand(page);
  const toCharge = myHand.find((c) => c.kind === '随从');
  expect(
    toCharge,
    `充能阶段手里应有随从可充能，实测手牌：${JSON.stringify(myHand)}`,
  ).toBeDefined();
  await pick(page, [toCharge!.index]);
  await page.getByTestId('charge').click();
  // 自己充能保持原文案「<卡名> 置入费用区」—— 卡名必须真的出现
  await expect(log, `自己充能应念出卡名「${toCharge!.name}」`).toContainText(
    `${toCharge!.name} 置入费用区`,
    { timeout: 15_000 },
  );

  /*
   * ⑤ 把行动权交给电脑，等它进入充能阶段（回合开始强制收入 2 张 = 两条 `deck → cost`）。
   *
   *    轮询里点「结束回合」而不是先判断再点：开局是充能阶段还是别的阶段、电脑是否已经
   *    先手走过一轮，都由 seed 决定，写死顺序会跟 seed 一起漂。
   *
   *    ⚠️ 这里刻意把轮询结果落成断言而不是让 `expect.poll` 自己抛：这条用例要等**另一个
   *    行动方**（电脑）走完一轮，失败时必须能区分「没等到电脑的回合」和「等到了但文案没改」
   *    —— 把页面实测原文一起打印出来，是唯一的区分手段。
   */
  const seen = { text: '' };
  const foeCharged = await expect
    .poll(
      async () => {
        seen.text = await log.innerText();
        if (seen.text.includes('电脑 充能 1 张')) return true;
        const label = (await page.getByTestId('turn-label').innerText().catch(() => '')).trim();
        // 行动权还在我手上 → 交出去（电脑先手时 label 已是「对手回合」，不会重复点）
        if (label === '你的回合') {
          await page.getByTestId('end-turn').click({ timeout: 5_000 }).catch(() => {});
        }
        return false;
      },
      { timeout: 45_000 },
    )
    .toBe(true)
    .then(() => true)
    .catch(() => false);

  expect(
    foeCharged,
    `电脑应进入充能阶段并刷出「电脑 充能 1 张」，战报实测：${seen.text}`,
  ).toBe(true);

  /*
   * ⑥ 先证明这一批行真的渲染出来了，再否认卡名 —— 顺序不能反。
   *
   *    强制收入是 `COST_INCOME_PER_TURN = 2` 张，所以至少有两条**精确等于**
   *    「电脑 充能 1 张」的行。精确等值同时承担两件事：证明行在（否则整段被吞掉时
   *    下面的断言是空验证），以及证明行里没有夹带卡名。
   */
  const lines = (await log.locator('p').allInnerTexts()).map((t) => t.trim());
  const incomeLines = lines.filter((t) => t === '电脑 充能 1 张');
  expect(
    incomeLines.length,
    `电脑进入充能阶段的强制收入是 2 张，战报末尾实测：${JSON.stringify(lines.slice(-12))}`,
  ).toBeGreaterThanOrEqual(2);

  // ⑦ 所有形如「充能 N 张」的行必须**逐字等于**「电脑 充能 1 张」——
  //    多出任何一个词（卡名、归属前缀）都会在这里被抓住。不用「不含某个卡名」的写法：
  //    E2E 拿不到电脑卡组的完整牌名表，「不含 X」在 X 猜错时是空验证。
  const chargeLines = lines.filter((t) => t.includes('充能 1 张'));
  expect(
    chargeLines.filter((t) => t !== '电脑 充能 1 张'),
    `充能行不得夹带卡名，实测：${JSON.stringify(chargeLines)}`,
  ).toEqual([]);

  /*
   * ⑧ 为什么不干脆断言「所有『置入费用区』的行都不属于电脑」：
   *
   *    `card:moved` 的文案形如 `X 置入费用区`，**本身不带玩家名** ——
   *    照字面断言「不含 电脑 置入费用区」永远成立，是典型的假绿。
   *    而按 Era 的表格，手牌 / 场上 → 费用区属「离手即公开」，仍然要念卡名
   *    （电脑自己充能时就会打印这类行），所以「所有置入费用区都不许出现」也是错的。
   *    真正会泄露的只有 `牌库顶 → 费用区` 这一条路径，它已经被上面 ⑥ 的精确等值钉住。
   *    这里只保留一条与文案无关的底线：战报里不得出现「电脑 的」，避免将来有人
   *    在充能行前缀归属时顺手写出「电脑 的 霜律终裁」这种形态。
   */
  expect(lines.join('\n'), '战报里不该出现「电脑 的」这种归属前缀').not.toContain('电脑 的');
});
