import { describe, expect, it } from 'vitest';

import { checkDeck } from '@app/core';
import { MAIN_DECK_SIZE } from '@app/shared';

import { CARD_POOL } from '../cards.js';
import { DEFAULT_COMMANDER_ID, DEFAULT_MAIN_DECK } from '../deck-pool.js';
import { seedGameState } from './session.js';

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

  it('每位玩家的指挥官都是唯一的那张 commander', () => {
    const s = seedGameState({ seats, seed: 1 });
    for (const id of seats) {
      expect(s.players[id]!.commanderDefId).toBe(DEFAULT_COMMANDER_ID);
      expect(CARD_POOL[DEFAULT_COMMANDER_ID]!.type).toBe('commander');
    }
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
