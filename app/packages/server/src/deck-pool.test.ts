import { describe, expect, it } from 'vitest';

import { CARD_POOL } from '@app/shared/cards';
import { MAIN_DECK_SIZE, MAX_COPIES } from '@app/shared/constants';
import { BASIC_DECKS, FACTION_DECKS, deckRecipeProblems } from '@app/shared/default-decks';

import { defaultDeckSetup } from './deck-pool.js';

/**
 * 三套基础卡组（D-169）—— 客户端预置 / 服务端回退共用这一份数据。
 *
 * 钉住的是「这三套开箱即用」这件事本身：张数对、同名不超、不含指挥官、
 * `defId` 全都存在。任何一条不满足，客户端预置出来的就是一套**不能开局**的卡组，
 * 而玩家看到的是「凑满 30 张才能用」——症状和「默认卡组没做」一模一样，很难查。
 */

describe('三套基础卡组', () => {
  it('阵营齐全：炎刃 / 霜律 / 星轨各一套', () => {
    expect(BASIC_DECKS.map((d) => d.faction)).toEqual(['blade', 'frost', 'star']);
    expect(Object.keys(FACTION_DECKS).sort()).toEqual(['blade', 'frost', 'star']);
  });

  it('每套正好 30 张', () => {
    for (const deck of BASIC_DECKS) {
      const total = Object.values(deck.recipe).reduce((a, b) => a + b, 0);
      expect(total, `${deck.name} 配方合计`).toBe(MAIN_DECK_SIZE);
      expect(deck.deck.length, `${deck.name} 展开后张数`).toBe(MAIN_DECK_SIZE);
    }
  });

  it('每套都通过合法性校验（同名 ≤3 / 不含指挥官 / 卡牌存在）', () => {
    for (const deck of BASIC_DECKS) {
      expect(deckRecipeProblems(deck.recipe), `${deck.name} 应无问题`).toEqual([]);
    }
  });

  it('配方里没有指挥官、没有衍生物', () => {
    const ids = BASIC_DECKS.flatMap((d) => Object.keys(d.recipe));
    for (const id of ids) {
      const def = CARD_POOL[id];
      expect(def, `未知卡牌 ${id}`).toBeDefined();
      expect(def!.type, `${def!.name} 不该出现在主卡组配方里`).not.toBe('commander');
    }
  });

  it('同名张数都不超过上限', () => {
    for (const deck of BASIC_DECKS) {
      for (const [id, n] of Object.entries(deck.recipe)) {
        expect(n, `${deck.name} 的 ${id}`).toBeLessThanOrEqual(MAX_COPIES);
        expect(n).toBeGreaterThan(0);
      }
    }
  });

  it('三套各不相同（避免复制粘贴导致两套一样）', () => {
    const keys = BASIC_DECKS.map((d) => Object.keys(d.recipe).sort().join(','));
    expect(new Set(keys).size).toBe(3);
  });

  it('指挥官与阵营一一对应', () => {
    expect(FACTION_DECKS.blade.commander).toBe('bladeLord');
    expect(FACTION_DECKS.frost.commander).toBe('frostAdjudicator');
    expect(FACTION_DECKS.star.commander).toBe('starWatcher');
  });
});

describe('defaultDeckSetup 的阵营回退', () => {
  it('未选阵营时按座位轮换：0 炎刃、1 霜律、2 星轨', () => {
    const { decks, commanders } = defaultDeckSetup(['p0', 'p1', 'p2']);
    expect(decks.p0).toEqual(FACTION_DECKS.blade.deck);
    expect(decks.p1).toEqual(FACTION_DECKS.frost.deck);
    expect(decks.p2).toEqual(FACTION_DECKS.star.deck);
    expect(commanders.p0).toBe('bladeLord');
    expect(commanders.p1).toBe('frostAdjudicator');
    expect(commanders.p2).toBe('starWatcher');
  });

  it('显式选了阵营就按选择给', () => {
    const { commanders } = defaultDeckSetup(['p0', 'p1'], { p1: 'star' });
    expect(commanders.p0).toBe('bladeLord');
    expect(commanders.p1).toBe('starWatcher');
  });
});
