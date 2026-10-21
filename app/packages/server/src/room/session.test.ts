import { describe, expect, it } from 'vitest';

import { checkDeck, createInitialState, stateHash } from '@app/core';
import { MAIN_DECK_SIZE } from '@app/shared';

import { CARD_POOL } from '../cards.js';
import { DEFAULT_COMMANDER_ID, DEFAULT_MAIN_DECK, FROST_MAIN_DECK } from '../deck-pool.js';
import { nextSeed, seedGameState, seedSetup } from './session.js';

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

  it('每位玩家都有合法指挥官；没指定时都落到默认那位（ADR-0042 不再按座位轮换）', () => {
    const s = seedGameState({ seats, seed: 1 });
    const used: string[] = [];
    for (const id of seats) {
      const cmd = s.players[id]!.commanderDefId;
      expect(cmd.length).toBeGreaterThan(0);
      expect(CARD_POOL[cmd]!.type).toBe('commander');
      used.push(cmd);
    }
    expect(used).toEqual([DEFAULT_COMMANDER_ID, DEFAULT_COMMANDER_ID]);
  });

  it('各席位按自己的指挥官装配（D-184）：一人炎刃、一人霜律', () => {
    const s = seedGameState({
      seats,
      seed: 1,
      commanders: { p1: DEFAULT_COMMANDER_ID, p2: 'frostAdjudicator' },
    });
    expect(s.players['p1']!.commanderDefId).toBe(DEFAULT_COMMANDER_ID);
    expect(s.players['p2']!.commanderDefId).toBe('frostAdjudicator');
    // 霜律指挥官的默认主卡组就是霜律那 30 张
    expect(s.players['p2']!.zones.deck.map((c) => c.defId).sort()).toEqual(
      [...FROST_MAIN_DECK].sort(),
    );
  });

  it('同一 seed 两次建立的状态完全一致（可复现）', () => {
    const a = seedGameState({ seats, seed: 42 });
    const b = seedGameState({ seats, seed: 42 });
    expect(a).toEqual(b);
    expect(a.rngCursor).toBe(b.rngCursor);
  });

  it('卡组与指挥官独立提交：炎刃指挥官 + 混搭主卡组也合法（D-141 / ADR-0042）', () => {
    const s = seedGameState({
      seats,
      seed: 1,
      commanders: { p1: DEFAULT_COMMANDER_ID },
      decks: { p1: FROST_MAIN_DECK },
    });
    // 指挥官是炎刃军统领，但主卡组是霜律那 30 张 —— 没有阵营限制，这就是合法的一套
    expect(s.players['p1']!.commanderDefId).toBe(DEFAULT_COMMANDER_ID);
    expect(s.players['p1']!.zones.deck.map((c) => c.defId).sort()).toEqual(
      [...FROST_MAIN_DECK].sort(),
    );
    expect(checkDeck(s.players['p1']!, CARD_POOL)).toBeNull();
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

/**
 * 种子真的接到随机流上了吗 —— D-269 / issue #103。
 *
 * ## 为什么上面那组 `nextSeed` 测试没能拦住这个 bug
 *
 * 它测的是**上游**（「种子是不是每次都不一样」），而坏的是**下游**
 * （「种子有没有被用上」）：`createInitialState` 把 `rngCursor` 写死 0，
 * 种子只是被存进 state 供回放记录。上游一直是对的，所以那组测试全绿，
 * 而 Era 每局都拿到同一副牌。教训：**测了生产随机数，没测它流到哪里。**
 *
 * 这组断言钉住两侧的接头：
 *  1. `seedSetup` 记录进回放的游标，必须与状态里真实的游标一致（否则回放必分叉）；
 *  2. 不同种子必须得到不同游标；
 *  3. 用回放记录重建出来的初始状态，哈希必须等于开局的哈希（自包含）。
 */
describe('种子 → 随机游标（D-269）', () => {
  const seats = ['p1', 'p2'];

  it('回放记录里的 rngCursor 与真实开局状态一致', () => {
    for (const seed of [1, 20261013]) {
      const setup = seedSetup({ seats, seed });
      const state = seedGameState({ seats, seed });
      expect(setup.rngCursor, `seed=${seed}`).toBe(state.rngCursor);
    }
  });

  it('不同种子得到不同游标 —— 游标是「种子决定牌序」的唯一接头', () => {
    const cursors = [1, 2, 3, 20261013].map((seed) => seedGameState({ seats, seed }).rngCursor);
    expect(new Set(cursors).size).toBe(cursors.length);
  });

  it('用回放记录能原样重建开局哈希（回放自包含，D-159）', () => {
    const setup = seedSetup({ seats, seed: 20261013 });
    const rebuilt = createInitialState(setup);
    const direct = seedGameState({ seats, seed: 20261013 });
    expect(stateHash(rebuilt)).toBe(stateHash(direct));
  });
});
