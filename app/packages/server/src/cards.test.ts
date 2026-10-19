import { describe, expect, it } from 'vitest';

import { checkDeck, createInitialState } from '@app/core';
import { MAIN_DECK_SIZE, MAX_COPIES, type CardDef } from '@app/shared';

import { CARD_POOL, PLACEHOLDER_CARD_IDS, isBladeCard, isFrostCard } from './cards.js';
import {
  BLADE_MAIN_DECK_RECIPE,
  DEFAULT_COMMANDER_ID,
  DEFAULT_MAIN_DECK,
  FROST_COMMANDER_ID,
  FROST_MAIN_DECK,
  FROST_MAIN_DECK_RECIPE,
} from './deck-pool.js';

/** Era 首批样例提供的 5 张卡 —— 这是「转录」与「占位」的分界线。 */
const ERA_PROVIDED_IDS = ['bladeLord', 'bladeVanguard', 'bladeScout', 'bladeTactician', 'bladeOrder'];

/**
 * 卡池自检 —— 目标不是测规则（那是 core 的事），而是**钉住卡池自身的状态**：
 * 哪些卡是 Era 给的、哪些是占位、当前够不够组一副合法卡组。ADR-0015 / ADR-0018。
 */
describe('卡池样例（ADR-0015）', () => {
  it('每张卡都有 defId / name / type / cost / power', () => {
    for (const [key, def] of Object.entries(CARD_POOL)) {
      expect(def.defId, `defId 应与键一致: ${key}`).toBe(key);
      expect(def.name.length, `${key} 缺 name`).toBeGreaterThan(0);
      expect(def.cost, `${key} 缺 cost`).toBeTypeOf('number');
      expect(def.power, `${key} 缺 power`).toBeTypeOf('number');
    }
  });

  it('双阵营各恰好一张指挥官（ADR-0025）', () => {
    const commanders = Object.values(CARD_POOL).filter((c) => c.type === 'commander');
    expect(commanders.map((c) => c.name).sort()).toEqual(['炎刃军统领', '霜律裁决官'].sort());
  });

  it('卡名类别判定按「卡名包含炎刃 / 霜律」的卡面口径', () => {
    expect(isBladeCard(CARD_POOL['bladeScout']!)).toBe(true);
    expect(isFrostCard(CARD_POOL['frostRecruit']!)).toBe(true);
    const other: CardDef = { defId: 'x', name: '霜狼士兵', type: 'minion', cost: 1, power: 1 };
    expect(isBladeCard(other)).toBe(false);
    expect(isFrostCard(other)).toBe(false);
  });
});

describe('卡池补全（ADR-0018）', () => {
  it('非指挥官卡种数足以组出 30 张主卡组（每种 ≤ 3）', () => {
    const mainPool = Object.values(CARD_POOL).filter((c) => c.type !== 'commander');
    expect(mainPool.length * MAX_COPIES).toBeGreaterThanOrEqual(MAIN_DECK_SIZE);
  });

  it('默认主卡组恰好 30 张，且每种都不超过同名上限', () => {
    expect(DEFAULT_MAIN_DECK).toHaveLength(MAIN_DECK_SIZE);

    const counts = new Map<string, number>();
    for (const id of DEFAULT_MAIN_DECK) counts.set(id, (counts.get(id) ?? 0) + 1);

    for (const [id, n] of counts) {
      expect(n, `${id} 超过同名上限`).toBeLessThanOrEqual(MAX_COPIES);
      expect(CARD_POOL[id], `默认卡组引用了不存在的卡: ${id}`).toBeDefined();
    }
    // 配比表与展开结果必须一致，否则两者会各说各话
    const fromRecipe = Object.values(BLADE_MAIN_DECK_RECIPE).reduce((a, b) => a + b, 0);
    expect(fromRecipe).toBe(DEFAULT_MAIN_DECK.length);
  });

  it('霜律默认卡组同样 30 张、同名不超限、可过卡组校验', () => {
    expect(FROST_MAIN_DECK).toHaveLength(MAIN_DECK_SIZE);
    const counts = new Map<string, number>();
    for (const id of FROST_MAIN_DECK) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) {
      expect(n, `${id} 超过同名上限`).toBeLessThanOrEqual(MAX_COPIES);
      expect(CARD_POOL[id], `霜律卡组引用了不存在的卡: ${id}`).toBeDefined();
    }
    const fromRecipe = Object.values(FROST_MAIN_DECK_RECIPE).reduce((a, b) => a + b, 0);
    expect(fromRecipe).toBe(FROST_MAIN_DECK.length);

    const state = createInitialState({
      seed: 1,
      seats: ['p1', 'p2'],
      decks: { p1: FROST_MAIN_DECK, p2: FROST_MAIN_DECK },
      commanders: { p1: FROST_COMMANDER_ID, p2: FROST_COMMANDER_ID },
    });
    for (const id of state.seats) {
      expect(checkDeck(state.players[id]!, CARD_POOL)).toBeNull();
    }
  });

  it('默认主卡组能通过 core 的卡组构成校验', () => {
    const state = createInitialState({
      seed: 1,
      seats: ['p1', 'p2'],
      decks: { p1: DEFAULT_MAIN_DECK, p2: DEFAULT_MAIN_DECK },
      commanders: { p1: DEFAULT_COMMANDER_ID, p2: DEFAULT_COMMANDER_ID },
    });
    for (const id of state.seats) {
      expect(checkDeck(state.players[id]!, CARD_POOL)).toBeNull();
    }
  });

  it('占位卡清单与卡池对齐（防止清单腐化）', () => {
    const placeholders = new Set(PLACEHOLDER_CARD_IDS);
    expect(placeholders.size, '占位清单存在重复项').toBe(PLACEHOLDER_CARD_IDS.length);

    for (const id of placeholders) {
      const def = CARD_POOL[id];
      expect(def, `清单里有但卡池中没有: ${id}`).toBeDefined();
      expect(def!.type, `占位卡不应是指挥官: ${id}`).not.toBe('commander');
    }
    // Era 提供的卡绝不能被当成占位数据
    for (const id of ERA_PROVIDED_IDS) {
      expect(placeholders.has(id), `Era 提供的卡被误列为占位: ${id}`).toBe(false);
    }
  });
});
