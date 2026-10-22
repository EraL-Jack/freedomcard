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
 * ## 充能**不是**漏洞（#143 纠正 #136）
 *
 * #136 曾经把充能（`deck → cost`）也一起藏成「电脑 充能 1 张」，依据写的是
 * 「Era 2026-10-21 23:47『充能那一行请一并收口』」—— **那句话不存在**：
 * Era 只批了抽牌，把充能一起收口是当时自己加的（属伪造决策归属，与 D-283 同类）。
 *
 * Era 2026-10-22 拍板（`docs/16 §7.5` C-06）：一张牌可见与否**只看它在哪个区**。
 * 充能的终点是**费用区**，费用区是公开区 —— 所以战报要念卡名，桌面也要能点开看。
 * 本用例因此同时钉两边：
 *  ① 电脑充能**念卡名**（`电脑 将 X 置入费用区`），且不再出现「充能 1 张」；
 *  ② 电脑抽牌仍只记「抽了 1 张」—— **不能因为本条把抽牌也放开**。
 */
test('人机局：电脑抽牌只记「抽了 1 张」，充能念卡名（#136 / #143）', async ({ browser }) => {
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
   * ⑤ 把行动权交给电脑，等它进入充能阶段。
   *
   *    回合开始的强制收入是 2 张（`COST_INCOME_PER_TURN = 2`），加上 AI 现在也会
   *    主动把手牌充能（#137），所以电脑的费用区一定会长起来。
   *
   *    轮询里点「结束回合」而不是先判断再点：开局是谁先手、电脑是否已经走过一轮，
   *    都由 seed 决定，写死顺序会跟 seed 一起漂。
   *
   *    ⚠️ 这里刻意把轮询结果落成断言而不是让 `expect.poll` 自己抛：这条用例要等
   *    **另一个行动方**走完一轮，失败时必须能区分「没等到电脑的回合」和「等到了但文案没改」
   *    —— 把页面实测原文一起打印出来，是唯一的区分手段。
   */
  /*
   * ⚠️ 一次等到**两条**，不是「等到第一条再立刻数」。
   *
   * 强制收入是逐张发的（两条 `card:moved`），渲染有先后；首版等到第一条就断言
   * 「≥2 条」，全量跑时被抓了个正着（实测只剩 1 条）。所以把「等」和「数」合成
   * 一个轮询：凑满 2 条才算等到。
   */
  const FOE_CHARGE = /电脑 将 .+ 置入费用区/;
  const foeChargeLinesNow = async (): Promise<string[]> =>
    (await log.locator('p').allInnerTexts()).map((t) => t.trim()).filter((t) => FOE_CHARGE.test(t));

  const foeCharged = await expect
    .poll(
      async () => {
        const n = (await foeChargeLinesNow()).length;
        if (n >= 2) return n;
        const label = (await page.getByTestId('turn-label').innerText().catch(() => '')).trim();
        // 行动权还在我手上 → 交出去（电脑先手时 label 已是「对手回合」，不会重复点）
        if (label === '你的回合') {
          await page.getByTestId('end-turn').click({ timeout: 5_000 }).catch(() => {});
        }
        return n;
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThanOrEqual(2)
    .then(() => true)
    .catch(() => false);

  expect(
    foeCharged,
    `电脑充能应刷出至少两条「电脑 将 <卡名> 置入费用区」（强制收入 2 张 / #143），实测：${JSON.stringify(await foeChargeLinesNow())}`,
  ).toBe(true);

  const lines = (await log.locator('p').allInnerTexts()).map((t) => t.trim());
  const foeChargeLines = lines.filter((t) => FOE_CHARGE.test(t));

  /*
   * ⑦ 每一条都必须**真的带卡名** —— 不能退化成「电脑 将 置入费用区」，
   *    也不能残留 #136 的「电脑 充能 1 张」。
   */
  for (const line of foeChargeLines) {
    const name = line.replace(/^电脑 将 /, '').replace(/ 置入费用区$/, '').trim();
    expect(name.length, `充能行必须念卡名，实测行：${line}`).toBeGreaterThan(0);
    expect(name, `充能行不该是「1 张」这种退化写法，实测行：${line}`).not.toMatch(/^\d+ 张$/);
  }
  expect(
    lines.filter((t) => t.includes('充能 1 张')),
    '「充能 N 张」是 #136 的错误口径（费用区是公开区），#143 起不该再出现',
  ).toEqual([]);

  /*
   * ⑧ 抽牌那一半**没有被连带放开**：整段战报里不得出现「电脑 抽到 <卡名>」。
   *    本轮改动只动 `deck → cost` 一支，抽牌仍走隐藏区判定。
   */
  expect(
    lines.filter((t) => t.startsWith('电脑 抽到 ')),
    `抽牌必须仍然隐藏（#136 有效，不能因为 #143 一起放开）：${JSON.stringify(lines)}`,
  ).toEqual([]);

  expect(lines.join('\n'), '战报里不该出现「电脑 的」这种归属前缀').not.toContain('电脑 的');
});

/**
 * 战报里不许出现英文协议串（issue #121 / D-291）。
 *
 * 症状：中文界面蹦出 `draw:completed`、`mulligan:closed`，玩家会当成报错。
 * 根因是事件翻译的 `default` 直接回显事件名。修法是**未映射就隐藏**。
 *
 * 这条用例不看代码，只看**玩家真正读到的文本** —— 逐行扫整块战报，
 * 任何一行匹配 `^[a-z][a-z-]*:[a-z-]+$`（协议串的形态）就算失败。
 */
test('战报里只有中文，不出现 draw:completed 这类协议串（#121）', async ({ browser }) => {
  test.setTimeout(90_000);
  const { page } = await startSoloGame(browser);

  // 顺便盯住控制台：战报的 React key 冲突只在浏览器里可见（#135）
  const consoleNoise: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleNoise.push(m.text());
  });

  // 走满一个回合，让阶段切换 / 抽牌收尾 / 换牌关闭这些事件都真的产生过
  await expect(page.getByTestId('log')).toContainText('换牌结束，进入第一回合', { timeout: 20_000 });
  await expect(page.getByTestId('end-turn')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('end-turn').click();
  await expect.poll(() => turnNo(page), { timeout: 20_000 }).toBe(2);

  const text = await page.getByTestId('log').innerText();
  const lines = text.split('\n').map((x) => x.trim()).filter((x) => x.length > 0);
  expect(lines.length, '战报应该有内容').toBeGreaterThan(3);

  // 协议串的形态：小写标识符 + 冒号，整行只有它（如 `draw:completed` / `mulligan:closed`）
  const protocol = lines.filter((x) => /^[a-z][a-z-]*:[a-z-]+$/.test(x));
  expect(protocol, `战报里出现了英文协议串：${protocol.join(' / ')}`).toHaveLength(0);

  // 顺带钉住 #135：这一局不该出现 React 的 key 冲突警告
  const keyWarnings = consoleNoise.filter((x) => x.includes('same key'));
  expect(keyWarnings, `出现 React key 冲突：${keyWarnings.join(' / ')}`).toHaveLength(0);
});
