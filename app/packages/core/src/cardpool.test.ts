/**
 * 卡池数据纪律（P-07 / T-01）。
 *
 * 这里测的**不是卡牌效果**（那在 `effects/*.test.ts`），而是卡表本身的数值约定 ——
 * 这一类错误不会让任何对局报错，只会在某天悄悄算出「打脸回血」或「衍生物当随从打」。
 *
 * 覆盖两条 Era 2026-10-21 的决定：
 * - **P-07 / D-240**：`damage` 允许 0（以后有降攻击效果），但禁止负数与小数。
 * - **T-01**：衍生物（`TOKEN_CARD_IDS`）**不得进入卡组**，构筑卡池必须排除它们。
 */

import { describe, expect, it } from 'vitest';

import type { CardDef } from '@app/shared/types';
import { CARD_POOL, TOKEN_CARD_IDS, validateCardPool } from '@app/shared/cards';

import { checkDeck } from './deck.js';
import { createInitialState } from './state.js';

describe('卡池数值自检（D-240）', () => {
  it('真实卡池全部合法', () => {
    expect(validateCardPool()).toBeNull();
  });

  it('damage 允许 0 —— 0 伤害的卡是合法的（纯效果卡）', () => {
    const pool: Record<string, CardDef> = {
      zero: { defId: 'zero', name: '零伤随从', type: 'minion', cost: 1, power: 2, damage: 0 },
    };
    expect(validateCardPool(pool)).toBeNull();
  });

  it('damage 为负数 → 报错（否则打脸会变成加血）', () => {
    const pool: Record<string, CardDef> = {
      neg: { defId: 'neg', name: '负伤随从', type: 'minion', cost: 1, power: 2, damage: -1 },
    };
    expect(validateCardPool(pool)).toContain('负伤随从');
    expect(validateCardPool(pool)).toContain('允许 0');
  });

  it('damage 为小数 → 报错（血量会出现 0.5，既不能显示也不能比较）', () => {
    const pool: Record<string, CardDef> = {
      half: { defId: 'half', name: '半分随从', type: 'minion', cost: 1, power: 2, damage: 1.5 },
    };
    expect(validateCardPool(pool)).toContain('非负整数');
  });

  it('cost / power 为负 → 报错', () => {
    const badCost: Record<string, CardDef> = {
      c: { defId: 'c', name: '负费卡', type: 'minion', cost: -2, power: 1 },
    };
    expect(validateCardPool(badCost)).toContain('费用');
    const badPower: Record<string, CardDef> = {
      p: { defId: 'p', name: '负力卡', type: 'minion', cost: 1, power: -3 },
    };
    expect(validateCardPool(badPower)).toContain('力量值');
  });
});

describe('衍生物不进卡组（T-01）', () => {
  /** 与 `DeckScreen` 的待选卡池同口径：排除指挥官与衍生物。 */
  const buildable = Object.values(CARD_POOL).filter(
    (c) => c.type !== 'commander' && !TOKEN_CARD_IDS.includes(c.defId),
  );

  it('构筑卡池里一张衍生物都没有', () => {
    for (const id of TOKEN_CARD_IDS) {
      expect(buildable.some((c) => c.defId === id)).toBe(false);
    }
  });

  it('衍生物确实是 0 费 —— 这就是必须排除的原因（否则等于白嫖随从）', () => {
    for (const id of TOKEN_CARD_IDS) {
      expect(CARD_POOL[id]?.cost).toBe(0);
    }
  });

  it('状态层兜底：卡组里混入衍生物 → checkDeck 报错', () => {
    // 30 张：29 张正常随从 + 1 张衍生物（第一张就是 token）
    const deck = [TOKEN_CARD_IDS[0]!, ...Array<string>(29).fill('bladeScout')];
    let n = 0;
    const s = createInitialState({
      seed: 1,
      seats: ['p1', 'p2'],
      decks: { p1: deck, p2: deck },
      commanders: { p1: 'bladeLord', p2: 'bladeLord' },
    });
    // 给卡组补上 uid，模拟装配完成的状态
    const p1 = {
      ...s.players['p1']!,
      zones: {
        ...s.players['p1']!.zones,
        deck: deck.map((defId) => ({ uid: `u${n++}`, defId })),
      },
    };
    expect(checkDeck(p1, CARD_POOL)).toContain('衍生物');
  });
});
