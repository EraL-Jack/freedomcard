import { describe, expect, it } from 'vitest';

import { createInitialState } from '@app/core';
import type { CardInstance, GameState, Phase, PlayerState } from '@app/shared/types';

import { TURN_SWITCHING_LABEL, actionability, choiceSideLabels, turnGuidance } from './selectors.js';

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

  describe('开局换牌（D-259：独立阶段，不属于任何回合）', () => {
    /** 处于换牌阶段、尚未确认的状态。 */
    function inMulligan(patch: Partial<PlayerState> = {}): GameState {
      return player(base({ phase: 'mulligan' }), ME, { mulliganDone: false, ...patch });
    }

    it('换牌阶段且未确认 → 可以换牌', () => {
      expect(actionability(inMulligan(), ME, NOW).canMulligan).toBe(true);
    });

    it('已经确认过（mulliganDone）→ 不再给', () => {
      expect(actionability(inMulligan({ mulliganDone: true }), ME, NOW).canMulligan).toBe(false);
    });

    it('不在换牌阶段 → 一律不给（第一回合充能阶段也不再给，X-17 已废弃）', () => {
      const charging = player(base({ phase: 'charge' }), ME, {
        chargeCount: 1,
        firstChargeAt: NOW,
        mulliganDone: false,
      });
      expect(actionability(charging, ME, NOW).canMulligan).toBe(false);
    });

    it('换牌是双方同时的，不看轮次：后攻方在手牌上同样可点', () => {
      // activeSeat = 1（对手先攻），我是 p1 —— 仍然能换牌、能点手牌。
      const s = { ...inMulligan(), activeSeat: 1 };
      const a = actionability(s, ME, NOW);
      expect(a.myTurn).toBe(false);
      expect(a.canMulligan).toBe(true);
      expect(a.canPickHand).toBe(true);
    });

    it('换牌的选择不受时间窗约束（界面不判时间，超时由服务端兜底）', () => {
      // 服务端 30s 后替未确认方提交；在那之前界面不该自己先关掉，
      // 否则窗口一过双方都点不动，阶段永远关不掉。
      expect(actionability(inMulligan(), ME, NOW + 3_600_000).canMulligan).toBe(true);
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

/**
 * 回合内指引（D-258 / D-268）。
 *
 * D-268 的由来是 Era 的 issue #101：「充能阶段的提示在切换回合之前显示了」。
 * 根因不在引擎 —— 事件流里回合边界本来就是两条（`phase:changed(… → charge)` +
 * `turn:changed`），是**客户端逐条播放**把中间那一帧渲染了出来：
 * 阶段已经是下一回合的充能，`activeSeat` 还是上一家，于是结束回合的人
 * 看到「你的回合 · 充能阶段：点手牌里的随从…」，停 750ms 才交棒给对手。
 *
 * 这个局面从未真实存在过，所以判据加了 `turnChangePending`：边界在播时
 * 不给指引、也不宣称是谁的回合。下面第一条就是拿它钉住回归 ——
 * 去掉那个参数（等价于改回「只看 phase」，正是出错前的写法），它会立刻变红。
 */
describe('回合内指引（D-268）', () => {
  it('回合边界播放中：不宣称是谁的回合、也不给「该你操作」的指引', () => {
    // 中间态：phase 已是下一回合的充能，activeSeat 仍是 ME（旧代码在这里显示「你的回合 · 充能阶段」）
    const mid = base({ phase: 'charge', activeSeat: 0 });
    const g = turnGuidance(mid, ME, true);
    expect(g.hint).toBe('');
    expect(g.label).toBe(TURN_SWITCHING_LABEL);
    expect(g.tone).toBe('pending');

    // 边界落地之后，同一份状态才允许给指引
    const settled = turnGuidance(mid, ME, false);
    expect(settled.hint).toContain('充能阶段');
    expect(settled.label).toBe('你的回合');
  });

  it('对手回合不给指引；换牌阶段交给换牌状态条', () => {
    const foeTurn = turnGuidance(base({ phase: 'charge', activeSeat: 1 }), ME, false);
    expect(foeTurn.hint).toBe('');
    expect(foeTurn.label).toBe('对手回合');
    expect(foeTurn.tone).toBe('foe');

    const mulligan = turnGuidance(base({ phase: 'mulligan' }), ME, false);
    expect(mulligan).toEqual({ hint: '', label: null, tone: 'foe' });
  });

  it('四个可操作阶段各有一句人话；结束/重置阶段不需要指引', () => {
    const hintOf = (phase: Phase): string => turnGuidance(base({ phase }), ME, false).hint;
    expect(hintOf('charge')).toContain('充能');
    expect(hintOf('draw')).toContain('抽一张');
    expect(hintOf('main')).toContain('出牌');
    expect(hintOf('battle')).toContain('点对方目标');
    expect(hintOf('end')).toBe('');
    expect(hintOf('reset')).toBe('');
  });

  it('待定选择挂起时只说「你的回合」，不给其他指引（与 D-152 口径一致）', () => {
    const s: GameState = {
      ...base({ phase: 'main' }),
      pendingChoice: { playerId: ME, kind: 'blade-lord-1', sourceUid: 'u1', options: [] },
    };
    const g = turnGuidance(s, ME, false);
    expect(g.hint).toBe('');
    expect(g.label).toBe('你的回合');
  });
});

describe('待定选择的阵营标注（issue #105）', () => {
  const card = (uid: string, defId = 'bladeRecruit'): CardInstance => ({ uid, defId });

  /** 给某个玩家的随从区塞几张卡（保持其它区域不变）。 */
  function withBoard(s: GameState, id: string, board: CardInstance[]): GameState {
    const p = s.players[id]!;
    return player(s, id, { zones: { ...p.zones, board } });
  }

  it('候选跨双方才标注：己方「我方」、对手「敌方」', () => {
    let s = base({ phase: 'main' });
    s = withBoard(s, ME, [card('mine1')]);
    s = withBoard(s, FOE, [card('foe1')]);
    const labels = choiceSideLabels(s, {
      playerId: ME,
      kind: 'blade-lord-1-target',
      sourceUid: 'lord1',
      options: ['mine1', 'foe1'],
    });
    expect(labels).toEqual({ mine1: '我方', foe1: '敌方' });
  });

  it('只有单边候选时一律不标注（冻结敌方、检视己方这些不该挂噪声）', () => {
    let s = base({ phase: 'main' });
    s = withBoard(s, ME, [card('mine1'), card('mine2')]);
    s = withBoard(s, FOE, [card('foe1')]);
    const onlyMine = choiceSideLabels(s, {
      playerId: ME,
      kind: 'blade-lord-1-target',
      sourceUid: 'lord1',
      options: ['mine1', 'mine2'],
    });
    expect(onlyMine).toEqual({});

    const onlyFoe = choiceSideLabels(s, {
      playerId: ME,
      kind: 'frost-edict-freeze',
      sourceUid: 'f1',
      options: ['foe1'],
    });
    expect(onlyFoe).toEqual({});
  });

  it('子效果档位（不是卡 uid）不参与阵营判定，也不影响跨边判断', () => {
    let s = base({ phase: 'main' });
    s = withBoard(s, ME, [card('mine1')]);
    s = withBoard(s, FOE, [card('foe1')]);
    const labels = choiceSideLabels(s, {
      playerId: ME,
      kind: 'blade-lord-1',
      sourceUid: 'lord1',
      options: ['l1', 'l3'],
    });
    expect(labels).toEqual({});
  });
});

describe('先攻第一回合「零抽牌」的抽牌阶段（issue #109）', () => {
  /*
   * 引擎已改成瞬穿，这个局面正常不会停住；客户端这一层是**双保险 + 播放中间帧**：
   * `phase:changed` 每条停 750ms，瞬穿那一批中间必然出现一两帧 `phase === 'draw'`，
   * 那时不能给「点击抽牌」（服务端早已在主要阶段，点了只会换回 WRONG_PHASE）。
   */
  const zeroDraw = (): GameState => base({ phase: 'draw', turn: 1, activeSeat: 0 });
  const normalDraw = (): GameState => base({ phase: 'draw', turn: 2, activeSeat: 1 });

  it('该抽 0 张时不给抽牌动作', () => {
    const a = actionability(zeroDraw(), ME, NOW);
    expect(a.myTurn).toBe(true);
    expect(a.canDraw).toBe(false);
  });

  it('该抽 2 张时照旧给抽牌动作', () => {
    expect(actionability(normalDraw(), FOE, NOW).canDraw).toBe(true);
  });

  it('该抽 0 张时也不给「点卡组抽一张」的指引 —— 不指引一个不存在的动作', () => {
    expect(turnGuidance(zeroDraw(), ME, false).hint).toBe('');
    expect(turnGuidance(normalDraw(), FOE, false).hint).toContain('抽一张');
  });
});
