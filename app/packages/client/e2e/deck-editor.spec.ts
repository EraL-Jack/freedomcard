import { expect, test } from '@playwright/test';

import { newClient } from './helpers.js';

/**
 * 卡组编辑页的新结构（Era 2026-10-20 三条要求 / D-169）。
 *
 * 覆盖三件此前没有用例的事：
 *  1. 首次进入预置三套基础卡组，每套 30 张、可直接设为开局；
 *  2. 待选条目可展开详情，详情里的加减同步到上方已选区；
 *  3. 分类张数统计（随从 / 法术 / 设置）随加减变化。
 *
 * 与 `deck.spec.ts` 的分工：那条测的是「走完整链路能开局」，这条测**编辑页本身**的交互，
 * 不组局、不建房，跑得快。
 */

/** 手机竖屏 —— 触控目标 24×20 只在窄屏被投诉（issue #115）。 */
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true } as const;

/**
 * #115：移动端卡组编辑的 ± 按钮只有 24×20px（`px-2 py-0.5 text-xs`），
 * 手指点不中 —— Era 的原话是「加减按钮太小，容易点错」。
 *
 * 判定标准是**触控目标尺寸**而不是像素级样式：宽高都 ≥40（约 40×40 的通用下限）。
 * 桌面不要求变大（`sm:` 收回紧凑样式），所以只在移动视口断言；
 * 已选区 / 待选区两套 ± 都要测 —— 它们是两处独立实现（`deck-sel-*` / `deck-*`），
 * 只改一处同样会漏。
 */
test('390px 竖屏：卡组编辑的 ± 按钮与搜索框都是 ≥40px 的触控目标（issue #115）', async ({
  browser,
}) => {
  const page = await newClient(browser, 'DeckTouch', PHONE);
  await page.getByTestId('edit-deck').click();
  await expect(page.getByTestId('deck-total')).toHaveText('30');

  const targets = [
    // 已选区（`deck-sel-*`）
    'deck-sel-remove-bladeScout',
    'deck-sel-add-bladeScout',
    // 待选区（`deck-*`）
    'deck-remove-bladeScout',
    'deck-add-bladeScout',
  ];
  for (const id of targets) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, `${id} 应存在（加减按钮是编辑卡组的唯一入口）`).not.toBeNull();
    expect(box!.width, `${id} 宽度应 ≥40px（实测 ${box!.width}px）`).toBeGreaterThanOrEqual(40);
    expect(box!.height, `${id} 高度应 ≥40px（实测 ${box!.height}px）`).toBeGreaterThanOrEqual(40);
  }

  // 搜索框同属「手指要点」的那一类：太扁同样点不准
  const search = await page.getByTestId('deck-search').boundingBox();
  expect(search, 'deck-search 应存在').not.toBeNull();
  expect(search!.height, `deck-search 高度应 ≥40px（实测 ${search!.height}px）`).toBeGreaterThanOrEqual(
    40,
  );

  await page.context().close();
});

test('首次进入预置三套基础卡组，每套 30 张且可直接设为开局', async ({ browser }) => {
  const page = await newClient(browser, 'DeckDefault');
  await page.getByTestId('edit-deck').click();

  // 三套基础卡组都在（slug 只是标识，不是阵营 —— ADR-0042）
  for (const slug of ['blade', 'frost', 'star']) {
    await expect(page.getByTestId(`deck-tab-basic-${slug}`)).toBeVisible();
  }

  // 默认选中第一套，正好 30 张且判为合法
  await expect(page.getByTestId('deck-total')).toHaveText('30');
  await expect(page.getByTestId('deck-problems')).toContainText('合法');

  // 切到星轨，仍是完整的一套
  await page.getByTestId('deck-tab-basic-star').click();
  await expect(page.getByTestId('deck-total')).toHaveText('30');
  await expect(page.getByTestId('deck-problems')).toContainText('合法');

  // 完整卡组可以直接设为开局，不需要再手动凑
  await expect(page.getByTestId('use-deck')).toBeVisible();
  await page.getByTestId('use-deck').click();
  await expect(page.getByTestId('deck-in-use')).toBeVisible();
});

test('待选条目展开详情，详情内加减同步到已选区', async ({ browser }) => {
  const page = await newClient(browser, 'DeckDetail');
  await page.getByTestId('edit-deck').click();

  // 新建一套空卡组
  await page.getByTestId('deck-new').click();
  await expect(page.getByTestId('deck-total')).toHaveText('0');
  await expect(page.getByTestId('deck-selected')).toContainText('还没选卡');

  // 点条目展开详情
  await page.getByTestId('deck-row-bladeScout').click();
  const detailAdd = page.getByTestId('deck-detail-add-bladeScout');
  await expect(detailAdd).toBeVisible();

  // 详情内加 2 张
  await detailAdd.click();
  await detailAdd.click();
  await expect(page.getByTestId('deck-total')).toHaveText('2');

  // 上方已选区出现该卡
  await expect(page.getByTestId('deck-selected')).toContainText('炎刃斥候');

  // 详情是**模态**浮层：打开时下方的已选区点不到，先关闭再操作
  await page.getByTestId('deck-detail-close').click();
  await expect(page.getByTestId('deck-detail-add-bladeScout')).toBeHidden();

  // 已选区减 1 → 总数回到 1（两区共用同一份数据）
  await page.getByTestId('deck-sel-remove-bladeScout').click();
  await expect(page.getByTestId('deck-total')).toHaveText('1');
});

test('同名上限 3 张：加到 3 后再点 ＋ 不再增加', async ({ browser }) => {
  const page = await newClient(browser, 'DeckCap');
  await page.getByTestId('edit-deck').click();
  await page.getByTestId('deck-new').click();

  const add = page.getByTestId('deck-add-bladeScout');
  for (let i = 0; i < 3; i++) await add.click();
  await expect(page.getByTestId('deck-total')).toHaveText('3');
  await expect(add).toBeDisabled();

  // 第 4 次用 force：绕过 Playwright 的可点击性等待（否则会一直等一个 disabled 按钮直到超时），
  // 借它验证「即使硬点也不会增加」—— 浏览器对 disabled 按钮本来就不派发 click。
  await add.click({ force: true });
  await expect(page.getByTestId('deck-total')).toHaveText('3');
});

test('分类张数统计随加减变化', async ({ browser }) => {
  const page = await newClient(browser, 'DeckCounts');
  await page.getByTestId('edit-deck').click();
  await page.getByTestId('deck-new').click();

  await expect(page.getByTestId('deck-counts')).toHaveText('随从 0 · 法术 0 · 设置 0');

  // 炎刃斥候是随从：加 2 张后随从数应为 2
  await page.getByTestId('deck-add-bladeScout').click();
  await page.getByTestId('deck-add-bladeScout').click();
  await expect(page.getByTestId('deck-counts')).toHaveText('随从 2 · 法术 0 · 设置 0');

  // 减回 1 张
  await page.getByTestId('deck-remove-bladeScout').click();
  await expect(page.getByTestId('deck-counts')).toHaveText('随从 1 · 法术 0 · 设置 0');
});

test('不进入编辑页，主界面下拉里已经有三套基础卡组', async ({ page }) => {
  // 关键：只 goto，不点「编辑卡组」。三套卡组必须由入口初始化写入，
  // 否则玩家不走编辑页就永远看不到它们 —— 那就等于「默认卡组没准备好」。
  await page.goto('/');

  const choice = page.getByTestId('deck-choice');
  await expect(choice).toBeVisible();

  // 正好三套预置的基础卡组（D-184：没有「阵营默认」这一项了，也不再额外列一份虚拟的）
  await expect(choice.locator('option')).toHaveCount(3);
  await expect(choice).toContainText('炎刃');
  await expect(choice).toContainText('霜律');
  await expect(choice).toContainText('星轨');

  // 全部都是完整的 30 张，没有一项该被禁用
  await expect(choice.locator('option:disabled')).toHaveCount(0);

  // 选中的那套必须显示它自带的指挥官 —— 卡组与指挥官是一个整体
  await expect(page.getByTestId('deck-in-use')).toContainText('指挥官');
});

test('已设为开局的卡组被改到不足 30 张：两处都提示会回落', async ({ browser }) => {
  const page = await newClient(browser, 'DeckFallback');
  await page.getByTestId('edit-deck').click();

  await page.getByTestId('deck-tab-basic-star').click();
  await page.getByTestId('use-deck').click();
  await expect(page.getByTestId('deck-in-use')).toBeVisible();

  // 减一张 → 29 张，不再合法
  await page.getByTestId('deck-sel-remove-starScout').click();
  await expect(page.getByTestId('deck-total')).toHaveText('29');
  await expect(page.getByTestId('deck-fallback-hint')).toContainText('开局会回落');

  // 主界面也必须说清楚，否则玩家以为用的就是这套
  await page.getByRole('button', { name: '返回' }).click();
  await expect(page.getByTestId('deck-incomplete-hint')).toBeVisible();
});

test('删除卡组要二次确认，取消不删', async ({ browser }) => {
  const page = await newClient(browser, 'DeckDelete');
  await page.getByTestId('edit-deck').click();
  await expect(page.getByTestId('deck-total')).toHaveText('30');

  // 第一次点删除只出确认，不动数据
  await page.getByTestId('deck-delete').click();
  await page.getByTestId('deck-delete-cancel').click();
  await expect(page.getByTestId('deck-tab-basic-blade')).toBeVisible();
  await expect(page.getByTestId('deck-total')).toHaveText('30');

  // 再删并确认 → 真的删掉，剩下两套
  await page.getByTestId('deck-delete').click();
  await page.getByTestId('deck-delete-confirm').click();
  await expect(page.getByTestId('deck-tab-basic-blade')).toHaveCount(0);
  await expect(page.getByTestId('deck-tab-basic-frost')).toBeVisible();
  await expect(page.getByTestId('deck-tab-basic-star')).toBeVisible();
});

test('准备页也说明为什么回落（不再有「阵营默认」）', async ({ browser }) => {
  const host = await newClient(browser, 'WaitHint');

  // 选星轨 → 设为开局 → 减一张（29 张，不再合法）
  await host.getByTestId('edit-deck').click();
  await host.getByTestId('deck-tab-basic-star').click();
  await host.getByTestId('use-deck').click();
  await host.getByTestId('deck-sel-remove-starScout').click();
  await expect(host.getByTestId('deck-total')).toHaveText('29');
  await host.getByRole('button', { name: '返回' }).click();

  // 建房即进准备页：结论（实际用哪套）与原因（所选卡组不足）都要在
  await host.getByTestId('create').click();
  await expect(host.getByTestId('waiting-deck-current')).toContainText('本局使用');
  await expect(host.getByTestId('waiting-deck-current')).toContainText('指挥官');
  await expect(host.getByTestId('waiting-deck-incomplete')).toBeVisible();
});

/**
 * 指挥官按钮的「选中 / 再看效果」双态（Era 2026-10-20）。
 *
 * Era 嫌右上角那个「看效果」按钮太挫，要求改成：点一下选中，选中的再点一次看效果。
 * 这条钉住两种点击的**不同后果** —— 只断言「点了会选中」的话，
 * 第二次点击被误实现成「取消选中」也照样过。
 */
test('指挥官：点一下选中，已选中的再点一次打开详情', async ({ browser }) => {
  const page = await newClient(browser, 'CmdClick');
  await page.getByTestId('edit-deck').click();
  await page.getByTestId('deck-tab-basic-frost').click();

  // 默认选中霜律裁决官
  await expect(page.getByTestId('deck-commander-frostAdjudicator')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // ① 点一位没选中的 → 选中，且**不**弹详情
  await page.getByTestId('deck-commander-starWatcher').click();
  await expect(page.getByTestId('deck-commander-starWatcher')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId('deck-commander-frostAdjudicator')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByTestId('deck-detail')).toHaveCount(0);

  // ② 再点已选中的 → 打开详情浮层，显示的是这位指挥官
  await page.getByTestId('deck-commander-starWatcher').click();
  await expect(page.getByTestId('deck-detail')).toBeVisible();
  await expect(page.getByTestId('deck-detail')).toContainText('星轨观测者');
  // 指挥官不占主卡组 → 详情里没有 ±
  await expect(page.getByTestId('deck-detail-commander-note')).toBeVisible();

  // ③ 关掉后仍是选中态（第二次点击不该把人取消掉）
  await page.getByTestId('deck-detail-close').click();
  await expect(page.getByTestId('deck-detail')).toHaveCount(0);
  await expect(page.getByTestId('deck-commander-starWatcher')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // ④ 右上角那个按钮确实没了
  await expect(page.getByTestId('deck-commander-detail')).toHaveCount(0);
});

/**
 * 待选区的卡名关键字搜索（Era 2026-10-20 / D-186）。
 *
 * Era 的原话：「在待选框加个关键字搜索，只要文本更新就自动执行一次卡名关键字搜索。」
 *
 * 这条要钉住的是「**文本更新即执行**」—— 没有搜索按钮、不等回车。
 * 所以第二次 `fill` 之后立刻断言列表变了：如果实现成「回车才筛」，这里会停在旧结果。
 */
test('待选搜索：文本一变就过滤，只匹配卡名，清空后恢复', async ({ browser }) => {
  const page = await newClient(browser, 'DeckSearch');
  await page.getByTestId('edit-deck').click();

  const rows = page.locator('[data-testid^="deck-row-"]');
  const total = await rows.count();
  expect(total).toBeGreaterThan(20);
  await expect(page.getByTestId('deck-pool-count')).toContainText(`共 ${total} 张`);

  const input = page.getByTestId('deck-search');

  // ① 输入「炎」→ 立刻只剩炎刃系的卡，命中数写在标题上
  await input.fill('炎');
  const afterFirst = await rows.count();
  expect(afterFirst).toBeGreaterThan(0);
  expect(afterFirst).toBeLessThan(total);
  await expect(page.getByTestId('deck-pool-count')).toContainText(
    `命中 ${afterFirst} / ${total}`,
  );
  // 命中项的卡名里必须有这个字（证明筛的是卡名，不是随机留下）
  for (const name of await rows.locator('span:first-child').allTextContents()) {
    expect(name).toContain('炎');
  }

  // ② 继续打字（不回车）→ 范围再收窄
  await input.fill('炎刃军');
  const afterSecond = await rows.count();
  expect(afterSecond).toBeGreaterThan(0);
  expect(afterSecond).toBeLessThan(afterFirst);
  for (const name of await rows.locator('span:first-child').allTextContents()) {
    expect(name).toContain('炎刃军');
  }
  // 指挥官不参与待选（「炎刃军统领」是 commander），搜它也不可能出现在列表里
  await expect(page.getByTestId('deck-row-bladeLord')).toHaveCount(0);

  // ③ 搜不到 → 明确说一句，而不是留一块空白
  await input.fill('根本没有这张卡');
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId('deck-search-empty')).toContainText('根本没有这张卡');

  // ④ 清空 → 立刻回到全部
  await page.getByTestId('deck-search-clear').click();
  await expect(input).toHaveValue('');
  await expect(rows).toHaveCount(total);
  await expect(page.getByTestId('deck-pool-count')).toContainText(`共 ${total} 张`);

  // ⑤ 全是空格不算搜索，不该把列表清空
  await input.fill('   ');
  await expect(rows).toHaveCount(total);
});
