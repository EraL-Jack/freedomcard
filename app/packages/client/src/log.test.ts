import { describe, expect, it } from 'vitest';

import type { GameEvent, GameState } from '@app/shared/types';

import { describeEvent } from './log.js';

/**
 * 事件 → 中文日志（B2-5 右侧战报列）。
 *
 * ## 为什么值得测
 *
 * 这一层不影响任何结算，但**玩家理解对局的唯一通道**就是它：
 * 「谁破坏了谁」「谁抽到了什么」全靠日志。E2E 也在读这些文案
 * （`turn.spec.ts` 等 `完成换牌`），文案改字就会连带改测试。
 *
 * 另外这里有一批「**必须返回 null**」的条目（记账事件、展示中转位移），
 * 多写一行就是一次攻击刷 4 条记录 —— 那种「噪音」比缺行更容易漏。
 */

const NAMES = { p1: 'Era', p2: 'Guest' } as const;

const ev = (type: string, payload: Record<string, unknown> = {}): GameEvent => ({
  type,
  at: 1_000,
  payload,
});

/** 只带一张手牌的状态 —— 用于验证「按 uid 反查卡名」。 */
function stateWithCard(uid: string, defId: string): GameState {
  return {
    seats: ['p1'],
    players: {
      p1: {
        id: 'p1',
        zones: {
          deck: [],
          hand: [{ uid, defId }],
          commander: [],
          board: [],
          spell: [],
          cost: [],
          graveyard: [],
          exile: [],
          reveal: [],
        },
      },
    },
  } as unknown as GameState;
}

describe('事件日志文案', () => {
  it('记账 / 中转事件不进日志（返回 null）', () => {
    expect(describeEvent(ev('rng:advance'), NAMES, null)).toBeNull();
    // 展示区是内部中转：进出都不写，玩家只看「展示：X」那一行
    expect(describeEvent(ev('card:moved', { to: 'reveal', uid: 'u1' }), NAMES, null)).toBeNull();
    expect(describeEvent(ev('card:moved', { from: 'reveal', uid: 'u1' }), NAMES, null)).toBeNull();
    expect(describeEvent(ev('deck:put-bottom'), NAMES, null)).toBeNull();
    // 选择的挂起/排队由浮层呈现，日志不需要
    expect(describeEvent(ev('choice:pending'), NAMES, null)).toBeNull();
  });

  it('抽牌 / 破坏 / 出牌用卡名而不是 defId', () => {
    const s = stateWithCard('u1', 'bladeScout');
    expect(describeEvent(ev('card:moved', { from: 'deck', to: 'hand', uid: 'u1', playerId: 'p1' }), NAMES, s)).toBe(
      'Era 抽到 炎刃斥候',
    );
    expect(describeEvent(ev('card:moved', { from: 'board', to: 'graveyard', uid: 'u1' }), NAMES, s)).toBe(
      '炎刃斥候 被破坏',
    );
  });

  it('查不到卡 / 玩家时退回 defId 与短 id，不出现空白', () => {
    expect(describeEvent(ev('card:moved', { to: 'cost', uid: 'u9' }), NAMES, null)).toBe(
      '— 置入费用区',
    );
    expect(describeEvent(ev('deck:shuffled', { playerId: 'p3-unknown' }), NAMES, null)).toBe(
      'p3-unk 洗牌',
    );
  });

  it('换牌 / 裁决 / 结束这些「玩家会截图」的行保持固定措辞', () => {
    expect(describeEvent(ev('mulligan:done', { playerId: 'p1' }), NAMES, null)).toBe('Era 完成换牌');
    expect(
      describeEvent(ev('combat:resolved', { atkPower: 2, defPower: 1, outcome: 'defender' }), NAMES, null),
    ).toBe('裁决 2 vs 1 → 防守方破坏');
    expect(describeEvent(ev('game:ended', { winner: 'p2' }), NAMES, null)).toBe(
      '对局结束，胜者：Guest',
    );
    // D-237 之后 40 轮不再判和，但旧回放仍可能带空 winner
    expect(describeEvent(ev('game:ended', { winner: '' }), NAMES, null)).toContain('平局');
  });

  it('未知事件类型回落成类型名（不吞事件，便于排查新事件漏翻译）', () => {
    expect(describeEvent(ev('some:new-event'), NAMES, null)).toBe('some:new-event');
  });

  /* ---- D-257 / D-258：新增事件必须有中文，且不能退化成英文标识符 ---- */

  it('顶替：说明「被顶替」而不是「被破坏」（顶替不是战斗结果）', () => {
    const s = stateWithCard('u1', 'bladeScout');
    const line = describeEvent(ev('unit:replaced', { slot: 1, byUid: 'u1', uid: 'u2' }), NAMES, s);
    expect(line).toContain('顶替');
    expect(line).toContain('炎刃斥候');
    expect(line).toContain('弃牌区');
    // 第 2 格（slot 1）要说成「第 2 格」，不能直接印 0 基下标
    expect(line).toContain('第 2 格');
  });

  it('顶替产生的离场位移不额外印「被破坏」', () => {
    expect(
      describeEvent(ev('card:moved', { from: 'board', to: 'graveyard', uid: 'u1', replaced: true }), NAMES, null),
    ).toBeNull();
  });

  it('自动充能用独立一行说清「+N 张」，与手动充能区分', () => {
    const line = describeEvent(ev('cost:income', { playerId: 'p1', amount: 2 }), NAMES, null);
    expect(line).toContain('2');
    expect(line).toContain('充能');
    expect(line).toContain('Era');
  });
});
