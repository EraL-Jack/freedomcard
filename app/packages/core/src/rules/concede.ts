/**
 * 认输 —— `docs/06` A3-4：随时认输。
 *
 * 「掉线等待 30s 由另一方决定是否直接获胜」是**房间层**的策略（涉及计时与通知），
 * 不属于规则引擎：规则引擎只负责把「认输」这个动作结算成 `game:ended`。
 */

import { RULE_ERRORS, type GameEvent, type GameState, type Intent, type Result, type Rejection, type RuleContext } from '@app/shared';

import { ev } from '../ops.js';
import { opponentOf } from '../state.js';

export const concedeRule = (
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
  const winner = opponentOf(state, intent.playerId);
  if (!winner) {
    return { ok: false, error: { code: RULE_ERRORS.NOT_YOUR_TURN, message: '认输方不在本局' } };
  }
  return { ok: true, value: [ev(ctx.now, 'game:ended', { winner, reason: 'concede' })] };
};
