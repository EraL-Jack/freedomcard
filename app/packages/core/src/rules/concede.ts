/**
 * 认输 —— `docs/06` A3-4：随时认输。
 *
 * 「掉线超过宽限期（`RECONNECT_GRACE_MS` = 60s）由房间层判负」是**房间层**的策略
 * （涉及计时与通知），不属于规则引擎：规则引擎只负责把「认输」这个动作结算成 `game:ended`。
 * 房间层判负时构造的系统 Intent 带 `reason: 'opponent-left'`，本规则把它原样写进事件成因（D-238）。
 */

import { RULE_ERRORS } from '@app/shared/constants';
import type { GameEvent, GameState, Intent, Result, Rejection, RuleContext } from '@app/shared/types';

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
  // 成因写进 `reason`（D-238 / P-02）：主动认输是 'concede'，
  // 对手离开 / 掉线超时释放是 'opponent-left'（由服务端 `abandonSeat` 构造系统 Intent 带上）。
  // 两种都判负，但结算面板要能说清「是自己投的，还是对面走了」。
  const reason = intent.reason === 'opponent-left' ? 'opponent-left' : 'concede';
  return { ok: true, value: [ev(ctx.now, 'game:ended', { winner, reason })] };
};
