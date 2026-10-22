/**
 * 抽牌（手动）—— Era 2026-10-18：**抽牌阶段的抽牌操作需要玩家点击牌组触发**，
 * 不再是「进入抽牌阶段自动抽」（此前在 `phase.ts` 的 `advanceOnce` 里）。
 *
 * 张数口径不变（A9 补充 1 / A10-3）：每回合抽 2 张；先攻方第一回合仅抽 1 张。
 *
 * Era 2026-10-19：**抽完牌直接自动推进到下一阶段**，不需要再点「推进阶段」。
 * 自动推进放在 `drawForPhase` 里（而非只在玩家链路的 `drawRule`），
 * 超时系统链路（`turn-end.ts`）走同一个函数，两条路径副作用一致（ADR-0011）。
 *
 * 阶段闭环：`phase.ts` 拒绝玩家在「未抽牌的抽牌阶段」推进（提示先点卡组）；
 * **抽 0 张的阶段由 `phase.ts` 自动推进**（`shouldAutoAdvanceDraw`），不会走到这里；
 * 超时链路走 `drawForPhase` **自动兜底抽牌** —— 否则超时会卡死在抽牌阶段。
 *
 * 历史（issue #139 / D-287）：上面那句「抽 0 张」原先特指先攻首回合。首回合现已改为抽 1 张，
 * 这条自动推进不再是首回合专用，而是「任何 0 张抽牌阶段」的通用能力。
 */

import { RULE_ERRORS } from '@app/shared/constants';
import type { GameEvent, GameState, Intent, Result, Rejection, RuleContext } from '@app/shared/types';

import { baseGuard, drawCards, ev, firstRejection } from '../ops.js';
import { reduce } from '../reducer.js';
import { activePlayer } from '../state.js';
import { advanceOnce, drawCountFor } from './phase.js';

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
  const events = [...drawn.events, ev(ctx.now, 'draw:completed', { playerId })];
  // Era 2026-10-19：抽完牌自动推进到下一阶段（事件流完整保留 phase:changed，
  // 「抽牌横幅停顿一下」由客户端播放节奏呈现，不进状态机 —— 与重置瞬穿同思路）。
  const s2 = events.reduce(reduce, state);
  events.push(...advanceOnce(s2, ctx));
  return events;
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
