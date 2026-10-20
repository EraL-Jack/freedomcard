import { describe, expect, it } from 'vitest';

import { CARD_POOL } from '@app/shared/cards';
import { MAIN_DECK_SIZE, MAX_COPIES } from '@app/shared/constants';
import {
  BASIC_DECKS,
  COMMANDER_IDS,
  basicDeckBySlug,
  basicDeckOfCommander,
  deckRecipeProblems,
} from '@app/shared/default-decks';

import { defaultDeckSetup, validateCommander } from './deck-pool.js';

/**
 * 三套基础卡组（D-169）—— 客户端预置 / 服务端回退共用这一份数据。
 *
 * 钉住的是「这三套开箱即用」这件事本身：张数对、同名不超、不含指挥官、
 * `defId` 全都存在。任何一条不满足，客户端预置出来的就是一套**不能开局**的卡组，
 * 而玩家看到的是「凑满 30 张才能用」——症状和「默认卡组没做」一模一样，很难查。
 *
 * ## D-184 / ADR-0042 之后
 *
 * 「阵营」没有了：`slug` 只是标识，不限制卡组里能放哪些卡。
 * 新的不变量是**每套基础卡组都绑一位合法指挥官**——它是「开局使用的那一套」的一部分。
 */

describe('三套基础卡组', () => {
  it('三套齐全：blade / frost / star（短名仅作标识，不是阵营）', () => {
    expect(BASIC_DECKS.map((d) => d.slug)).toEqual(['blade', 'frost', 'star']);
    for (const deck of BASIC_DECKS) {
      expect(basicDeckBySlug(deck.slug), `basicDeckBySlug(${deck.slug})`).toBe(deck);
    }
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

  it('每套的指挥官都是合法指挥官，且能反查回同一套', () => {
    for (const deck of BASIC_DECKS) {
      expect(validateCommander(deck.commander), `${deck.name} 的指挥官`).toBeNull();
      expect(basicDeckOfCommander(deck.commander), `${deck.commander} 反查`).toBe(deck);
    }
  });
});

describe('指挥官候选表', () => {
  it('COMMANDER_IDS 与卡池里的指挥官一一对应', () => {
    const inPool = Object.values(CARD_POOL)
      .filter((c) => c.type === 'commander')
      .map((c) => c.defId)
      .sort();
    expect([...COMMANDER_IDS].sort()).toEqual(inPool);
  });

  it('validateCommander：非指挥官 / 不存在的卡都给人话原因', () => {
    expect(validateCommander('bladeScout')).toContain('不是指挥官');
    expect(validateCommander('nope')).toContain('未知的指挥官');
  });
});

describe('defaultDeckSetup 的缺省回退（ADR-0042）', () => {
  it('什么都没给：所有席位都落到第一套基础卡组，不再按座位轮换', () => {
    const { decks, commanders } = defaultDeckSetup(['p0', 'p1', 'p2']);
    for (const id of ['p0', 'p1', 'p2']) {
      expect(decks[id]).toEqual(BASIC_DECKS[0]!.deck);
      expect(commanders[id]).toBe(BASIC_DECKS[0]!.commander);
    }
  });

  it('只给指挥官：配它自己那套 30 张', () => {
    const { decks, commanders } = defaultDeckSetup(['p0', 'p1'], { p1: 'starWatcher' });
    expect(commanders.p0).toBe('bladeLord');
    expect(decks.p0).toEqual(BASIC_DECKS[0]!.deck);
    expect(commanders.p1).toBe('starWatcher');
    expect(decks.p1).toEqual(basicDeckOfCommander('starWatcher')!.deck);
  });

  it('给了不认识的指挥官：保留该 id（由 validateCommander 在入站拦下），卡组回落第一套', () => {
    const { decks, commanders } = defaultDeckSetup(['p0'], { p0: 'madeUp' });
    expect(commanders.p0).toBe('madeUp');
    expect(decks.p0).toEqual(BASIC_DECKS[0]!.deck);
  });
});
