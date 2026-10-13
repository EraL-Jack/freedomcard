import { describe, expect, it } from 'vitest';

import type { CardDef } from '@app/shared';

import { CARD_POOL, isBladeCard } from './cards.js';

/**
 * 卡池自检 —— 目标不是测规则（那是 core 的事），而是**把「池不完整」这件事钉在测试里**，
 * 避免将来有人误以为样例池已经能开局。ADR-0015。
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

  it('恰好一张指挥官', () => {
    const commanders = Object.values(CARD_POOL).filter((c) => c.type === 'commander');
    expect(commanders.map((c) => c.name)).toEqual(['炎刃军统领']);
  });

  it('池尚不足以组成合法主卡组', () => {
    const mainPool = Object.values(CARD_POOL).filter((c) => c.type !== 'commander');
    // 同名上限 3 → 现有 4 张非指挥官卡最多 12 张，不足 30
    expect(mainPool.length * 3).toBeLessThan(30);
  });

  it('卡名类别判定按「卡名包含炎刃」的卡面口径', () => {
    expect(isBladeCard(CARD_POOL['bladeScout']!)).toBe(true);
    const other: CardDef = { defId: 'x', name: '霜狼士兵', type: 'minion', cost: 1, power: 1 };
    expect(isBladeCard(other)).toBe(false);
  });
});
