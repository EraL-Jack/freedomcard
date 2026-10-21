import { describe, expect, it } from 'vitest';

import { createInitialState } from '@app/core';
import type { GameState, Phase, PlayerState } from '@app/shared/types';

import { actionability } from './selectors.js';

/**
 * 可操作性判定（T-04）—— client 的第一个真单测。
 *
 * ## 为什么从这些开始
 *
 * `docs/21` T-04 说 client 3849 行零单测。逐条抄一遍渲染没意义，
 * 真正会「悄悄改坏」的是**按钮展不展示**的判据：
 * 换牌窗口什么时候关、待定选择期间还能点哪些、先攻方第一回合能不能打指挥官。
 * 这些错了的后果是「点了没反应」或「规则允许却没入口」，E2E 都不一定抓到。
 *
 * 判据现在住在 `selectors.ts`（纯函数），可以用**最小状态**精确构造，
 * 不需要渲染、不需要 socket、不需要等 30 秒真实时间。
 */

const ME = 'p1';
const FOE = 'p2';
const NOW = 1_000_000;

/** 最小可用的已开局状态：只填判定用得到的字段。 */
function base(
  patch: { phase?: Phase; activeSeat?: number; turn?: number; drawnThisPhase?: boolean } = {},
): GameState {
  const s = createInitialState({ seed: 3, seats: [ME, FOE], decks: {}, commanders: {} });
  return {
    ...s,
    started: true,
    phase: patch.phase ?? 'charge',
    activeSeat: patch.activeSeat ?? 0,
    turn: patch.turn ?? 3,
    drawnThisPhase: patch.drawnThisPhase ?? false,
    pendingChoice: null,
  };
}

/** 改某个玩家的一项（保持不可变）。 */
function player(s: GameState, id: string, patch: Partial<PlayerState>): GameState {
  const p = s.players[id]!;
  return { ...s, players: { ...s.players, [id]: { ...p, ...patch } } };
}

describe('可操作性判定（T-04）', () => {
  it('不是自己的回合：手牌不可点、不能宣告攻击、不能抽牌', () => {
    const s = base({ phase: 'main', activeSeat: 1 });
    const a = actionability(s, ME, NOW);
    expect(a.myTurn).toBe(false);
    expect(a.canPickHand).toBe(false);
    expect(a.canBattle).toBe(false);
    expect(a.canDraw).toBe(false);
    expect(a.canCommanderAttack).toBe(false);
  });

  it('手牌只在充能 / 主要阶段可点；随从只在战斗阶段可宣告攻击', () => {
    expect(actionability(base({ phase: 'charge' }), ME, NOW).canPickHand).toBe(true);
    expect(actionability(base({ phase: 'main' }), ME, NOW).canPickHand).toBe(true);
    expect(actionability(base({ phase: 'battle' }), ME, NOW).canPickHand).toBe(false);
    expect(actionability(base({ phase: 'battle' }), ME, NOW).canBattle).toBe(true);
    expect(actionability(base({ phase: 'main' }), ME, NOW).canBattle).toBe(false);
  });

  it('抽牌阶段未抽牌才给「点击抽牌」', () => {
    expect(actionability(base({ phase: 'draw' }), ME, NOW).canDraw).toBe(true);
    expect(actionability(base({ phase: 'draw', drawnThisPhase: true }), ME, NOW).canDraw).toBe(false);
  });

  describe('换牌窗口（A8-3 / X-17 / Era 2026-10-19 时间窗）', () => {
    /** 处于「己方第一次充能阶段、刚进入」的状态。 */
    function charging(): GameState {
      const s = base({ phase: 'charge' });
      return player(s, ME, { chargeCount: 1, firstChargeAt: NOW, mulliganDone: false });
    }

    it('首次充能阶段 + 窗口内 + 未换过 → 可以换牌', () => {
      expect(actionability(charging(), ME, NOW).canMulligan).toBe(true);
    });

    it('过了 30 秒窗口就关（基准是各自 firstChargeAt，不是开局时刻）', () => {
      const s = charging();
      expect(actionability(s, ME, NOW + 30_000).canMulligan).toBe(true);
      expect(actionability(s, ME, NOW + 30_001).canMulligan).toBe(false);
    });

    it('第二次充能阶段不再给换牌（chargeCount ≠ 1）', () => {
      const s = player(charging(), ME, { chargeCount: 2 });
      expect(actionability(s, ME, NOW).canMulligan).toBe(false);
    });

    it('已经换过就不再给（mulliganDone 每人一次）', () => {
      const s = player(charging(), ME, { mulliganDone: true });
      expect(actionability(s, ME, NOW).canMulligan).toBe(false);
    });
  });

  describe('待定选择（ADR-0023 §2 全局守卫）', () => {
    const choice = (who: string) => ({
      playerId: who,
      kind: 'test',
      sourceUid: 'u1',
      options: ['a'],
    });

    it('挂给对手时不影响我的判定', () => {
      const s = { ...base({ phase: 'draw' }), pendingChoice: choice(FOE) };
      const a = actionability(s, ME, NOW);
      expect(a.choiceOpen).toBe(false);
      expect(a.canDraw).toBe(true);
    });

    it('挂给我时：抽牌与指挥官攻击一律关掉（引擎只放行回答 + 认输）', () => {
      const s = { ...base({ phase: 'draw' }), pendingChoice: choice(ME) };
      const a = actionability(s, ME, NOW);
      expect(a.choiceOpen).toBe(true);
      expect(a.canDraw).toBe(false);
    });
  });

  describe('指挥官攻击（docs/16 §6.1 / A10-3）', () => {
    function battle(patch: { turn?: number; activeSeat?: number } = {}): GameState {
      const s = base({ phase: 'battle', ...patch });
      return player(s, ME, {
        commanderAttacked: false,
        zones: { ...s.players[ME]!.zones, commander: [{ uid: 'cmd1', defId: 'bladeLord' }] },
      });
    }

    it('战斗阶段、本回合未攻击 → 可用', () => {
      expect(actionability(battle(), ME, NOW).canCommanderAttack).toBe(true);
    });

    it('本回合已攻击过 → 不可用', () => {
      const s = player(battle(), ME, { commanderAttacked: true });
      expect(actionability(s, ME, NOW).canCommanderAttack).toBe(false);
    });

    it('先攻方第一回合不能攻击（A10-3）', () => {
      const s = battle({ turn: 1, activeSeat: 0 });
      expect(actionability(s, ME, NOW).canCommanderAttack).toBe(false);
    });

    it('指挥官区为空时不给入口（还没揭示 / 已被移走）', () => {
      const s = player(battle(), ME, {
        zones: { ...base().players[ME]!.zones, commander: [] },
      });
      expect(actionability(s, ME, NOW).canCommanderAttack).toBe(false);
    });

    it('星轨观测者「攻击并展示」：指挥官是它 + 费用够才给', () => {
      const s = battle();
      const withStar = player(s, ME, {
        zones: {
          ...s.players[ME]!.zones,
          commander: [{ uid: 'cmd1', defId: 'starWatcher' }],
          cost: [{ uid: 'c1', defId: 'bladeScout' }],
        },
        usedCostThisTurn: 0,
        maxCost: 1,
      });
      expect(actionability(withStar, ME, NOW).canRevealAttack).toBe(true);

      // 费用区空 → 付不出这 1 费
      const noCost = player(withStar, ME, {
        zones: { ...withStar.players[ME]!.zones, cost: [] },
      });
      expect(actionability(noCost, ME, NOW).canRevealAttack).toBe(false);

      // 本回合额度已用满 → 同样付不出
      const noBudget = player(withStar, ME, { usedCostThisTurn: 1, maxCost: 1 });
      expect(actionability(noBudget, ME, NOW).canRevealAttack).toBe(false);
    });
  });
});
