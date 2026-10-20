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

test('首次进入预置三套基础卡组，每套 30 张且可直接设为开局', async ({ browser }) => {
  const page = await newClient(browser, 'DeckDefault');
  await page.getByTestId('edit-deck').click();

  // 三套基础卡组都在，且按阵营顺序
  for (const faction of ['blade', 'frost', 'star']) {
    await expect(page.getByTestId(`deck-tab-basic-${faction}`)).toBeVisible();
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
