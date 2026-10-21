import { describe, expect, it } from 'vitest';

import type { CardDef, GameState } from '@app/shared/types';

import { applyIntent, createInitialState, reduce, INTENTS } from './index.js';

/**
 * 种子是否真的决定了牌序 —— Era issue #103「每次进游戏都是固定起手，没洗牌吗」。
 *
 * ## 这里测的是**接线**，不是洗牌算法
 *
 * 洗牌与 RNG 本身早就有覆盖（`rng.test.ts`：同游标同结果、不同游标不同结果）。
 * 出问题的从来不是算法，而是**状态初始化时把种子丢了**：
 * `createInitialState` 里 `rngCursor` 恒为 `0`，`seed` 只是被存进 state 供回放记录，
 * 一次都没参与随机。于是每局洗牌的起手游标相同 → 洗牌结果相同 → 起手相同。
 *
 * 所以第一组断言直接钉**游标**：它是「种子 → 随机流」的唯一接头。
 * 只断言「起手不同」是不够的 —— 洗牌本身没错的情况下，起手偶尔撞车也可能发生，
 * 而游标是确定性的，接头断了就必然恒等。
 */

/** 卡池夹具（与 rules.test.ts 同思路：编卡，不引真实卡池）。 */
const CARDS: Record<string, CardDef> = {
  cmd: { defId: 'cmd', name: '指挥官', type: 'commander', cost: 0, power: 5 },
};
for (let i = 1; i <= 10; i++) {
  CARDS[`m${i}`] = { defId: `m${i}`, name: `随从${i}`, type: 'minion', cost: i % 5, power: i };
}

/** 主卡组 30 张（m1..m10 各 3 张）—— 只求通过 `checkDeck` 的构成校验。 */
const DECK: string[] = [];
for (let i = 1; i <= 10; i++) DECK.push(`m${i}`, `m${i}`, `m${i}`);

function initial(seed: number): GameState {
  return createInitialState({
    seed,
    seats: ['p1', 'p2'],
    decks: { p1: DECK, p2: DECK },
    commanders: { p1: 'cmd', p2: 'cmd' },
  });
}

/** 用指定种子跑一遍 `game:start`，返回开局后的状态。 */
function started(seed: number): GameState {
  const s = initial(seed);
  const ctx = { now: 1000, cards: CARDS };
  const r = applyIntent(s, { type: INTENTS.start, actor: 'system', playerId: 'p1', seq: 1 }, ctx);
  if (!r.ok) throw new Error(`意外拒绝: ${r.error.code} ${r.error.message}`);
  let out = s;
  for (const e of r.value) out = reduce(out, e);
  return out;
}

/** 某席位手牌的顺序（defId 序列）—— 玩家真正看到的东西。 */
function handOf(s: GameState, id: string): string {
  return s.players[id]!.zones.hand.map((c) => c.defId).join(',');
}

describe('D-269 种子必须真的决定牌序（issue #103）', () => {
  it('初始随机游标由 seed 决定，不能是常量', () => {
    const cursors = [1, 2, 3, 20261021].map((s) => initial(s).rngCursor);
    expect(new Set(cursors).size, `游标全部相同：${cursors.join(' / ')}`).toBe(cursors.length);
  });

  it('不同种子开局后起手不同（Era 报的「每次都是固定起手」）', () => {
    const hands = [1, 2, 3, 20261021].map((s) => handOf(started(s), 'p1'));
    expect(new Set(hands).size, `起手完全相同：${hands[0]}`).toBeGreaterThan(1);
  });

  it('不同种子洗出的整副牌序也不同（不只是发牌阶段）', () => {
    const decks = [7, 8].map((s) => started(s).players['p1']!.zones.deck.map((c) => c.defId).join(','));
    expect(decks[0]).not.toBe(decks[1]);
  });

  it('同一种子两次开局完全一致 —— 回放可复现的前提不能被这次修复破坏', () => {
    const a = started(20261021);
    const b = started(20261021);
    expect(handOf(a, 'p1')).toBe(handOf(b, 'p1'));
    expect(a.rngCursor).toBe(b.rngCursor);
    expect(a.seats).toEqual(b.seats);
  });
});
