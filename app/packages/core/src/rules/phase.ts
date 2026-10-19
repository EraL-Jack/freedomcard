/**
 * 阶段流转 —— `docs/06` A4-1 / A4-2 / A9 补充 1 / A10-3。
 *
 * 六阶段顺序固定、均不可跳过。这里把「进入某阶段的自动效果」也放在本文件：
 * 重置阶段清休眠 —— 它是阶段定义的一部分，不是独立机制。
 *
 * ⚠️ **抽牌不再是自动效果**（Era 2026-10-18）：进入抽牌阶段只重置
 * `drawnThisPhase`，抽牌由玩家点击卡组触发（`draw.ts`）；未抽牌时
 * 玩家不得推进到下一阶段。抽完后**自动推进**到下一阶段
 * （Era 2026-10-19，`drawForPhase` 内接续 `advanceOnce`）。
 */

import {
  COST_INCOME_PER_TURN,
  MAX_COST_CURVE,
  RULE_ERRORS,
  TURN_LIMIT,
  type GameEvent,
  type GameState,
  type Intent,
  type Phase,
  type PlayerId,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import { ev, maxCostChanged, phaseChanged, takeFromDeck, turnChanged } from '../ops.js';
import { reduce } from '../reducer.js';
import { activePlayer } from '../state.js';
import { syncCommanderGrowth } from './commander-growth.js';

/** 阶段顺序 —— A4-1，索引即推进顺序。 */
export const PHASE_ORDER: readonly Phase[] = ['charge', 'reset', 'draw', 'main', 'battle', 'end'];

/**
 * 第 `turn` 个**己方回合**的最高费用 —— docs/16 §3.3：1 → 3 → 5 → 10。
 * 「各自回合数」由调用方传 `chargeCount`（拿到回合即 +1），不能用全局 `turn`，
 * 否则后手会白拿一档（ADR-0024）。
 */
export function maxCostForTurn(turn: number): number {
  const idx = Math.min(Math.max(turn, 1), MAX_COST_CURVE.length) - 1;
  return MAX_COST_CURVE[idx] ?? MAX_COST_CURVE[MAX_COST_CURVE.length - 1]!;
}

/**
 * 推进**一个**阶段，返回产生的事件（含进入该阶段的自动效果）。
 *
 * 导出给 `turn-end.ts` 复用 —— 超时 / 主动结束回合走的必须是同一条路径，
 * 否则「系统代打的回合」会和「玩家自己打的回合」产生不同的副作用。
 */
export function advanceOnce(state: GameState, ctx: RuleContext): GameEvent[] {
  const at = ctx.now;
  const idx = PHASE_ORDER.indexOf(state.phase);
  const active = activePlayer(state);
  const events: GameEvent[] = [];

  if (idx >= 0 && idx + 1 < PHASE_ORDER.length) {
    const to = PHASE_ORDER[idx + 1]!;
    events.push(phaseChanged(at, state.phase, to));

    if (active) {
      // A4-1 重置阶段：清除己方随从的休眠态（A9-2）
      if (to === 'reset') {
        events.push(ev(at, 'units:reset', { playerId: active }));
      }
      // 抽牌阶段**不自动抽**（Era 2026-10-18）：抽牌 = 玩家点击卡组（`draw.ts`）。
      // reducer 在进入 draw 阶段时把 `drawnThisPhase` 重置为 false。
    }

    // Era 2026-10-18：**重置阶段自动运行、自动推进，不需要手动点**。
    // 实现为状态机瞬穿：进入 reset 后立刻继续推进到下一阶段，
    // 事件流完整保留（phase:changed ×2 + units:reset，A4-2 不破），
    // 「停顿一下 + 动画展示」由客户端的事件播放节奏呈现，不进状态机。
    if (to === 'reset') {
      const s2 = events.reduce(reduce, state);
      events.push(...advanceOnce(s2, ctx));
    }
    return events;
  }

  // 结束阶段之后 → 进入下一回合
  const nextSeat = state.seats.length > 1 ? (state.activeSeat + 1) % state.seats.length : state.activeSeat;
  const nextTurn = state.turn + 1;
  const nextPlayer: PlayerId | undefined = state.seats[nextSeat];

  // docs/16 §7：40 轮仍未分胜负 → 判和（全局回合 = 轮次 × 2）。
  if (nextTurn > TURN_LIMIT) {
    events.push(ev(at, 'game:ended', { winner: '', reason: 'draw' }));
    return events;
  }

  events.push(phaseChanged(at, state.phase, 'charge'));
  events.push(turnChanged(at, nextTurn, nextSeat));
  if (nextPlayer) {
    // docs/16 §3.3：按**各自回合数**取上限（turn:changed 会让 chargeCount +1）。
    const ownTurn = (state.players[nextPlayer]?.chargeCount ?? 0) + 1;
    events.push(maxCostChanged(at, nextPlayer, maxCostForTurn(ownTurn)));
    // docs/16 §2 充能①：强制收入 2 张（卡组顶 → 费用区，ADR-0024）。
    const p = state.players[nextPlayer];
    if (p) {
      const income = takeFromDeck(
        at,
        nextPlayer,
        { deck: p.zones.deck, graveyard: p.zones.graveyard },
        COST_INCOME_PER_TURN,
        state.rngCursor,
        'cost',
      );
      events.push(...income.events);
    }
    // docs/16 §2 充能② / §6.3：指挥官力量按轮次同步（双方同力）。
    events.push(...syncCommanderGrowth(state, nextTurn, ctx));
  }
  return events;
}

export const phaseRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  if (!state.started) {
    return { ok: false, error: { code: RULE_ERRORS.NOT_STARTED, message: '对局尚未开始' } };
  }
  if (state.winner !== null || state.draw) {
    return { ok: false, error: { code: RULE_ERRORS.GAME_OVER, message: '对局已结束' } };
  }
  if (intent.actor === 'player' && activePlayer(state) !== intent.playerId) {
    return { ok: false, error: { code: RULE_ERRORS.NOT_YOUR_TURN, message: '不是你的回合' } };
  }
  // Era 2026-10-18：抽牌必须点击卡组完成 —— 未抽牌的抽牌阶段**禁止推进**
  // （阶段不可跳过的含义随手动抽牌延伸到「阶段动作不可跳过」）。
  // 系统 Intent（超时）不受此限：由 `turn-end.ts` 兜底自动抽牌。
  if (intent.actor === 'player' && state.phase === 'draw' && !state.drawnThisPhase) {
    return {
      ok: false,
      error: { code: RULE_ERRORS.WRONG_PHASE, message: '请先点击卡组抽牌' },
    };
  }
  return { ok: true, value: advanceOnce(state, ctx) };
};
