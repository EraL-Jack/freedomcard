/**
 * 阶段流转 —— `docs/06` A4-1 / A4-2 / A9 补充 1 / A10-3。
 *
 * 六阶段顺序固定、均不可跳过。这里把「进入某阶段的自动效果」也放在本文件：
 * 重置阶段清休眠、抽排阶段抽牌 —— 它们是阶段定义的一部分，不是独立机制。
 */

import {
  DRAW_PER_TURN,
  FIRST_TURN_DRAW,
  MAX_COST_CURVE,
  RULE_ERRORS,
  type GameEvent,
  type GameState,
  type Intent,
  type Phase,
  type PlayerId,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import { drawCards, ev, maxCostChanged, phaseChanged, turnChanged } from '../ops.js';
import { activePlayer } from '../state.js';

/** 阶段顺序 —— A4-1，索引即推进顺序。 */
export const PHASE_ORDER: readonly Phase[] = ['charge', 'reset', 'draw', 'main', 'battle', 'end'];

/**
 * 第 `turn` 回合的最高费用 —— A5-2：1 → 3 → 5 → 10，第 4 回合达上限。
 * 写成查表而非公式，因为 Era 给的是离散的四个值。
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
      // A9 补充 1：抽排阶段抽 2 张；A10-3：先攻方第一回合仅抽 1 张
      if (to === 'draw') {
        const count = state.turn === 1 && state.activeSeat === 0 ? FIRST_TURN_DRAW : DRAW_PER_TURN;
        const p = state.players[active];
        if (p) {
          const drawn = drawCards(
            at,
            active,
            { deck: p.zones.deck, graveyard: p.zones.graveyard },
            count,
            state.rngCursor,
          );
          events.push(...drawn.events);
        }
      }
    }
    return events;
  }

  // 结束阶段之后 → 进入下一回合
  const nextSeat = state.seats.length > 1 ? (state.activeSeat + 1) % state.seats.length : state.activeSeat;
  const nextTurn = state.turn + 1;
  const nextPlayer: PlayerId | undefined = state.seats[nextSeat];

  events.push(phaseChanged(at, state.phase, 'charge'));
  events.push(turnChanged(at, nextTurn, nextSeat));
  if (nextPlayer) events.push(maxCostChanged(at, nextPlayer, maxCostForTurn(nextTurn)));
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
  if (state.winner !== null) {
    return { ok: false, error: { code: RULE_ERRORS.GAME_OVER, message: '对局已结束' } };
  }
  if (intent.actor === 'player' && activePlayer(state) !== intent.playerId) {
    return { ok: false, error: { code: RULE_ERRORS.NOT_YOUR_TURN, message: '不是你的回合' } };
  }
  return { ok: true, value: advanceOnce(state, ctx) };
};
