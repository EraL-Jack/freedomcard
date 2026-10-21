/**
 * AI 决策单测（D-242）。
 *
 * 这些用例只断言「**它选了哪一步**」，不断言整局结果 —— 后者属于 E2E。
 * 单测的价值在于：AI 是纯函数，摆一个局面就能精确验证它的取舍，
 * 比跑一局看日志快两个数量级。
 */

import { describe, expect, it } from 'vitest';

import type { CardDef, CardInstance, GameState, Phase } from '@app/shared/types';

import { decideAiMove } from './ai.js';
import { applyIntent, reduce, INTENTS } from './index.js';
import { createInitialState } from './state.js';

const CARDS: Record<string, CardDef> = {
  cmd: { defId: 'cmd', name: '指挥官', type: 'commander', cost: 0, power: 0 },
  cheap: { defId: 'cheap', name: '小随从', type: 'minion', cost: 1, power: 2 },
  big: { defId: 'big', name: '大随从', type: 'minion', cost: 4, power: 5 },
  taunt: { defId: 'taunt', name: '嘲讽随从', type: 'minion', cost: 2, power: 3, keywords: ['taunt'] },
  weak: { defId: 'weak', name: '弱随从', type: 'minion', cost: 1, power: 1 },
  strong: { defId: 'strong', name: '强随从', type: 'minion', cost: 2, power: 6 },
  spell: { defId: 'spell', name: '法术', type: 'spell', cost: 1, power: 0 },
};

const DECK = Array<string>(30).fill('cheap');
const c = (uid: string, defId: string): CardInstance => ({ uid, defId });

function craft(patch: {
  phase?: Phase;
  turn?: number;
  activeSeat?: number;
  /** **AI（'ai' 席）**自己的区域 —— 决策的主体。 */
  own?: Partial<Record<'hand' | 'board' | 'cost' | 'commander' | 'deck', CardInstance[]>>;
  /** **对手（'me' 席）**的区域 —— 攻击目标从这里挑。 */
  foe?: Partial<Record<'board' | 'commander' | 'deck', CardInstance[]>>;
  maxCost?: number;
  usedCost?: number;
  commanderAttacked?: boolean;
  pendingChoice?: GameState['pendingChoice'];
}): GameState {
  const base = createInitialState({
    seed: 7,
    seats: ['me', 'ai'],
    decks: { me: DECK, ai: DECK },
    commanders: { me: 'cmd', ai: 'cmd' },
  });
  const me = base.players['me']!;
  const ai = base.players['ai']!;
  return {
    ...base,
    started: true,
    phase: patch.phase ?? 'main',
    turn: patch.turn ?? 3,
    activeSeat: patch.activeSeat ?? 1,
    pendingChoice: patch.pendingChoice ?? null,
    players: {
      ...base.players,
      me: { ...me, zones: { ...me.zones, ...patch.foe } },
      ai: {
        ...ai,
        maxCost: patch.maxCost ?? 10,
        usedCostThisTurn: patch.usedCost ?? 0,
        commanderAttacked: patch.commanderAttacked ?? false,
        zones: {
          ...ai.zones,
          // 指挥官默认已揭示，攻击用例才不用每个都摆一遍
          commander: [c('ai#commander', 'cmd')],
          ...patch.own,
        },
      },
    },
  };
}

describe('decideAiMove · 回合边界', () => {
  it('不是 AI 的回合 → null（待定选择也不归它）', () => {
    const s = craft({ activeSeat: 0, phase: 'main' });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toBeNull();
  });

  it('对局已结束 → null', () => {
    const s = { ...craft({}), winner: 'me' as const };
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toBeNull();
  });

  it('AI 的回合、抽牌阶段未抽 → card:draw', () => {
    const s = craft({ phase: 'draw' });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({ type: 'card:draw' });
  });
});

describe('decideAiMove · 出牌', () => {
  it('优先出最贵的付得起的随从', () => {
    const s = craft({
      own: { hand: [c('h1', 'cheap'), c('h2', 'big')], cost: [c('c1', 'cheap'), c('c2', 'cheap'), c('c3', 'cheap'), c('c4', 'cheap')] },
    });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({ type: 'card:play', payload: { uid: 'h2' } });
  });

  it('费用区不够 → 退而求其次出便宜的', () => {
    const s = craft({
      own: { hand: [c('h1', 'cheap'), c('h2', 'big')], cost: [c('c1', 'cheap')] },
      maxCost: 1,
    });
    // cheap 实付 0（随从 −1），big 实付 3 —— 只有 cheap 付得起
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({ type: 'card:play', payload: { uid: 'h1' } });
  });

  it('一手牌都付不起 → 推进阶段（不发必被拒的 Intent）', () => {
    const s = craft({ own: { hand: [c('h1', 'big')], cost: [] }, maxCost: 1 });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({ type: 'phase:advance' });
  });

  it('随从区已满时不再出随从', () => {
    // `BOARD_SLOTS = 3`（docs/06 B2 三格）
    const board = Array.from({ length: 3 }, (_, i) => c(`b${i}`, 'cheap'));
    const s = craft({ own: { hand: [c('h1', 'cheap')], board, cost: [c('c1', 'cheap')] } });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({ type: 'phase:advance' });
  });

  /* ---- D-257：满场之后还能顶替 ---- */

  it('满场但手上有更强的随从 → 顶替最弱那一格', () => {
    const board: CardInstance[] = [
      { uid: 'b0', defId: 'big', slot: 0 }, // 力 5
      { uid: 'b1', defId: 'weak', slot: 1 }, // 力 1 ← 最弱
      { uid: 'b2', defId: 'cheap', slot: 2 }, // 力 2
    ];
    const s = craft({
      own: { hand: [c('h1', 'strong')], board, cost: [c('c1', 'cheap'), c('c2', 'cheap')] },
    });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({
      type: 'card:play',
      payload: { uid: 'h1', slot: 1 },
    });
  });

  it('满场且手上的随从不更强 → 不顶替（换弱/换平等于白扔一张牌）', () => {
    const board = Array.from({ length: 3 }, (_, i) => c(`b${i}`, 'cheap'));
    const s = craft({ own: { hand: [c('h1', 'weak')], board, cost: [c('c1', 'cheap')] } });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({ type: 'phase:advance' });
  });
});

describe('decideAiMove · 战斗', () => {
  it('对方有随从 → 打力量最低的那个（不是打脸）', () => {
    const s = craft({
      phase: 'battle',
      own: { board: [c('a1', 'strong')] },
      foe: { board: [c('f1', 'big'), c('f2', 'weak')] },
    });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({
      type: 'attack:declare',
      payload: { attackerUid: 'a1', targetUid: 'f2' },
    });
  });

  it('对方有嘲讽 → 只打嘲讽（A7），即使别的随从更弱', () => {
    const s = craft({
      phase: 'battle',
      own: { board: [c('a1', 'strong')] },
      foe: { board: [c('f1', 'weak'), c('f2', 'taunt')] },
    });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({
      type: 'attack:declare',
      payload: { attackerUid: 'a1', targetUid: 'f2' },
    });
  });

  it('对方空场 → 打指挥官', () => {
    const s = craft({ phase: 'battle', own: { board: [c('a1', 'strong')] }, foe: { board: [] } });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({
      type: 'attack:declare',
      payload: { attackerUid: 'a1', targetUid: 'me#commander' },
    });
  });

  it('随从全休眠、指挥官还没攻击 → 指挥官攻击', () => {
    const s = craft({
      phase: 'battle',
      own: { board: [{ ...c('a1', 'strong'), sleeping: true } as CardInstance] },
      foe: { board: [] },
    });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({ type: 'commander:attack' });
  });

  it('指挥官已攻击过、随从全休眠 → 推进阶段', () => {
    const s = craft({
      phase: 'battle',
      own: { board: [{ ...c('a1', 'strong'), sleeping: true } as CardInstance] },
      foe: { board: [] },
      commanderAttacked: true,
    });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({ type: 'phase:advance' });
  });

  it('先攻方第一回合不可攻击（A10-3）→ 直接推进', () => {
    const s = craft({
      phase: 'battle',
      turn: 1,
      activeSeat: 0,
      own: { board: [c('a1', 'strong')] },
      foe: { board: [] },
    });
    // activeSeat 0 时 AI 不是行动方 → null；这里把 AI 放到 0 席验证不可攻击
    const s2: GameState = { ...s, seats: ['ai', 'me'], activeSeat: 0 };
    expect(decideAiMove(s2, 'ai', CARDS, 1000)).toEqual({ type: 'phase:advance' });
  });
});

describe('decideAiMove · 待定选择（响应）', () => {
  it('选择属于 AI、但轮到对手行动 → 仍然回答（P-04 的 AI 侧）', () => {
    const s = craft({
      activeSeat: 0,
      pendingChoice: { playerId: 'ai', kind: 'x', sourceUid: 'u', options: ['opt-1', 'opt-2'] },
    });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({
      type: 'effect:choose',
      payload: { choice: 'opt-1' },
    });
  });

  it('没有可选项 → pass', () => {
    const s = craft({ pendingChoice: { playerId: 'ai', kind: 'x', sourceUid: 'u', options: [] } });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toEqual({
      type: 'effect:choose',
      payload: { choice: 'pass' },
    });
  });

  it('选择属于对手 → null（不替对方回答）', () => {
    const s = craft({ pendingChoice: { playerId: 'me', kind: 'x', sourceUid: 'u', options: ['a'] } });
    expect(decideAiMove(s, 'ai', CARDS, 1000)).toBeNull();
  });
});

describe('decideAiMove · 换牌', () => {
  const inMulligan = (startedAt: number | null, mulliganDone = false): GameState => {
    const s = craft({ phase: 'mulligan' });
    const ai = s.players['ai']!;
    return {
      ...s,
      startedAt,
      players: { ...s.players, ai: { ...ai, mulliganDone } },
    };
  };

  it('开局换牌阶段 → 主动提交一次（不换牌，只为关掉阶段）', () => {
    const s = inMulligan(1000);
    expect(decideAiMove(s, 'ai', CARDS, 2000)).toEqual({ type: 'mulligan', payload: { returns: [] } });
  });

  it('窗口已过仍要提交 —— 否则换牌阶段永远关不掉（D-259）', () => {
    // 窗口只约束「换牌」动作，不约束「跳过」；AI 发的正是跳过
    const s = inMulligan(1000);
    expect(decideAiMove(s, 'ai', CARDS, 1000 + 30_000 + 1)).toEqual({
      type: 'mulligan',
      payload: { returns: [] },
    });
  });

  it('已经换过 → 不再发', () => {
    const s = inMulligan(1000, true);
    expect(decideAiMove(s, 'ai', CARDS, 2000)).toEqual({ type: 'phase:advance' });
  });
});

/**
 * 自对弈（D-242）—— **AI 能不能把一局打完**。
 *
 * 这是人机对战最重要的一条保障：如果 AI 的决策在某些局面上「一步都走不了」，
 * 玩家看到的就是对面一动不动、等 30s 超时。单条决策用例证明不了这件事，
 * 只有让它自己跟自己打完整局才能暴露死循环与僵局。
 *
 * 用系统 Intent（`actor: 'system'`）提交，与真实服务端链路一致；
 * 决策被拒时同样走服务端那条兜底（推进阶段），保证「不卡死」的口径一致。
 */
describe('AI 自对弈：一局能打完', () => {
  // 合法卡组：10 种卡 × 3 张 = 30（`MAX_COPIES` = 3，所以不能只用一种卡刷 30 张）
  const DECK_CARDS: Record<string, CardDef> = {};
  for (let i = 0; i < 10; i++) {
    DECK_CARDS[`f${i}`] = {
      defId: `f${i}`,
      name: `填充随从${i}`,
      type: 'minion',
      cost: i % 3,
      power: 1 + (i % 5),
    };
  }
  const SELF_PLAY_CARDS: Record<string, CardDef> = { ...CARDS, ...DECK_CARDS };
  const SELF_PLAY_DECK = Array.from({ length: 10 }, (_, i) => `f${i}`).flatMap((id) => [id, id, id]);
  const SELF_PLAY_CTX = { now: 1000, cards: SELF_PLAY_CARDS };

  it('两个 AI 互相打，3000 步内必然分出结果（不卡死）', () => {
    const base = createInitialState({
      seed: 20261021,
      seats: ['a1', 'a2'],
      decks: { a1: SELF_PLAY_DECK, a2: SELF_PLAY_DECK },
      commanders: { a1: 'cmd', a2: 'cmd' },
    });

    /** 系统 Intent 执行器（与 service 层同一形态）。 */
    const fire = (state: GameState, type: string, playerId: string, payload?: Record<string, unknown>) => {
      const r = applyIntent(
        state,
        { type, actor: 'system', playerId, seq: 1, ...(payload ? { payload } : {}) },
        SELF_PLAY_CTX,
      );
      if (!r.ok) return null;
      return r.value.reduce(reduce, state);
    };

    let s: GameState = fire(base, INTENTS.start, 'a1')!;
    expect(s.started).toBe(true);

    let steps = 0;
    for (; steps < 3000; steps++) {
      if (s.winner !== null || s.draw) break;

      // 待定选择可能挂给非行动方（受伤展示），所以先问「该谁动」
      const actor = s.pendingChoice?.playerId ?? s.seats[s.activeSeat];
      if (!actor) break;

      const move = decideAiMove(s, actor, SELF_PLAY_CARDS, SELF_PLAY_CTX.now);
      if (!move) break;

      const next = fire(s, move.type, actor, move.payload);
      if (next) {
        s = next;
        continue;
      }
      // 决策被拒 → 与服务端同一条兜底：推进阶段，绝不原地重试。
      const fallback = fire(s, INTENTS.phaseAdvance, actor);
      if (!fallback) break;
      s = fallback;
    }

    // ① 必须结束（血空 / 40 轮裁定 / 即死模式）
    expect(s.winner !== null || s.draw).toBe(true);
    // ② 不能靠「跑满步数」蒙过去 —— 那样等于承认它会死循环
    expect(steps).toBeLessThan(3000);
    // ③ 结束原因必须是真实终局之一
    expect(['health', 'turn-limit', 'sudden-death']).toContain(s.endReason);
    // ④ 必须是「打出来」的结果，不是一路空推阶段推到 40 轮 ——
    //    双方血量加起来必定低于 16（至少有人掉了血），否则说明 AI 根本没在攻击。
    expect((s.players['a1']?.health ?? 0) + (s.players['a2']?.health ?? 0)).toBeLessThan(16);
  });
});
