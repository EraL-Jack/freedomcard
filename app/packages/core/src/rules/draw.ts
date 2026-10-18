/**
 * 抽牌（手动）—— Era 2026-10-18：**抽牌阶段的抽牌操作需要玩家点击牌组触发**，
 * 不再是「进入抽牌阶段自动抽」（此前在 `phase.ts` 的 `advanceOnce` 里）。
 *
 * 张数口径不变（A9 补充 1 / A10-3）：每回合抽 2 张；先攻方第一回合仅抽 1 张。
 *
 * 阶段闭环：`phase.ts` 拒绝玩家在「未抽牌的抽牌阶段」推进（提示先点卡组）；
 * 超时链路（`turn-end.ts`，系统 Intent）走 `drawForPhase` **自动兜底抽牌** ——
 * 否则超时会卡死在抽牌阶段，系统回合和玩家回合产生不同副作用（ADR-0011 精神）。
 */

import {
  DRAW_PER_TURN,
  FIRST_TURN_DRAW,
  RULE_ERRORS,
  type GameEvent,
  type GameState,
  type Intent,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import { baseGuard, drawCards, ev, firstRejection } from '../ops.js';
import { activePlayer } from '../state.js';

/**
 * 本阶段应抽的张数 —— 与旧自动抽牌口径完全一致（A9 补充 1 / A10-3）。
 * 单独导出是为了让「抽几张」只有一处定义（`phase.ts` 不再持有这份知识）。
 */
export function drawCountFor(state: GameState): number {
  return state.turn === 1 && state.activeSeat === 0 ? FIRST_TURN_DRAW : DRAW_PER_TURN;
}

/**
 * 产出「本阶段抽牌」的完整事件批 —— 供两个调用方复用：
 *  1. `drawRule`（玩家点击卡组）；
 *  2. `turn-end.ts`（超时系统链路的兜底自动抽牌）。
 */
export function drawForPhase(state: GameState, playerId: string, ctx: RuleContext): GameEvent[] {
  const p = state.players[playerId];
  if (!p) return [];
  const drawn = drawCards(
    ctx.now,
    playerId,
    { deck: p.zones.deck, graveyard: p.zones.graveyard },
    drawCountFor(state),
    state.rngCursor,
  );
  return [...drawn.events, ev(ctx.now, 'draw:completed', { playerId })];
}

export const drawRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  const guard = firstRejection(
    baseGuard(state, intent),
    state.phase !== 'draw'
      ? { code: RULE_ERRORS.WRONG_PHASE, message: '抽牌只在抽牌阶段进行' }
      : null,
  );
  if (guard) return { ok: false, error: guard };

  const me = intent.playerId;
  if (activePlayer(state) !== me) {
    return {
      ok: false,
      error: { code: RULE_ERRORS.NOT_YOUR_TURN, message: '不是你的回合' },
    };
  }
  if (state.drawnThisPhase) {
    return {
      ok: false,
      error: { code: RULE_ERRORS.DRAW_DONE, message: '本阶段已经抽过牌了' },
    };
  }

  return { ok: true, value: drawForPhase(state, me, ctx) };
};
