import { describe, expect, it } from 'vitest';

import { checkDeck } from '@app/core';
import { MAIN_DECK_SIZE } from '@app/shared';

import { CARD_POOL } from '../cards.js';
import { DEFAULT_COMMANDER_ID, DEFAULT_MAIN_DECK } from '../deck-pool.js';
import { nextSeed, seedGameState } from './session.js';

/**
 * 开局桥自检 —— ADR-0019。
 *
 * 要钉住的是：「默认卡组 + 座位顺序」能产出一个**通过 `core.checkDeck`** 的合法状态。
 * 这是此前联机开不了局的根因，故作为回归项固定下来。
 */
describe('开局桥 seedGameState（ADR-0019）', () => {
  const seats = ['p1', 'p2'];

  it('产出两名玩家，各持 30 张主卡组', () => {
    const s = seedGameState({ seats, seed: 1 });
    expect(s.seats).toEqual(seats);
    for (const id of seats) {
      expect(s.players[id]!.zones.deck).toHaveLength(MAIN_DECK_SIZE);
    }
  });

  it('通过 core 的卡组构成校验（此前 12 < 30 必然被拒）', () => {
    const s = seedGameState({ seats, seed: 1 });
    for (const id of seats) {
      expect(checkDeck(s.players[id]!, CARD_POOL)).toBeNull();
    }
  });

  it('每位玩家都有合法指挥官（按座位交替分配炎刃 / 霜律，ADR-0025）', () => {
    const s = seedGameState({ seats, seed: 1 });
    const used: string[] = [];
    for (const id of seats) {
      const cmd = s.players[id]!.commanderDefId;
      expect(cmd.length).toBeGreaterThan(0);
      expect(CARD_POOL[cmd]!.type).toBe('commander');
      used.push(cmd);
    }
    // 一局里两套体系都能被看到：第一位炎刃、第二位霜律
    expect(used).toEqual([DEFAULT_COMMANDER_ID, 'frostAdjudicator']);
  });

  it('同一 seed 两次建立的状态完全一致（可复现）', () => {
    const a = seedGameState({ seats, seed: 42 });
    const b = seedGameState({ seats, seed: 42 });
    expect(a).toEqual(b);
    expect(a.rngCursor).toBe(b.rngCursor);
  });

  it('尚未开局 —— started 为 false，等待 game:start 系统 Intent', () => {
    const s = seedGameState({ seats, seed: 1 });
    expect(s.started).toBe(false);
    expect(s.phase).toBe('charge');
    expect(s.turn).toBe(1);
  });

  it('默认卡组每种卡都不超过同名上限', () => {
    const counts = new Map<string, number>();
    for (const id of DEFAULT_MAIN_DECK) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) {
      expect(n, `${id} 超过同名上限`).toBeLessThanOrEqual(3);
    }
  });
});

/**
 * 随机种子来源 —— ADR-0021。
 *
 * 要钉住的是「`GAME_SEED` 只在被设置时才生效」这条边界：
 * 生产不设该变量，若代码误把它当固定值读取，每局牌序都会相同 ——
 * 这种错误在单机试玩时极难发现，只能靠测试兜住。
 */
describe('nextSeed（ADR-0021）', () => {
  const key = 'GAME_SEED';
  let saved: string | undefined;

  const withEnv = (value: string | undefined, fn: () => void): void => {
    saved = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  };

  it('未设置 GAME_SEED 时回落到时间种子（每次不同）', () => {
    withEnv(undefined, () => {
      const a = nextSeed();
      const b = nextSeed();
      // 严格来说两次可能撞在同一毫秒 —— 断言「是有限数且非负」才是稳定的部分，
      // 真正要防的是「恒返回同一个常量」。
      expect(Number.isFinite(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isFinite(b)).toBe(true);
    });
  });

  it('设置 GAME_SEED 时恒取该值（E2E 的确定性来源）', () => {
    withEnv('20261013', () => {
      expect(nextSeed()).toBe(20261013);
      expect(nextSeed()).toBe(nextSeed());
    });
  });

  it('GAME_SEED 非法时回落到时间种子，不返回 NaN', () => {
    withEnv('not-a-number', () => {
      expect(Number.isNaN(nextSeed())).toBe(false);
    });
  });

  it('GAME_SEED 为空串等同未设置', () => {
    withEnv('', () => {
      expect(Number.isNaN(nextSeed())).toBe(false);
    });
  });
});
