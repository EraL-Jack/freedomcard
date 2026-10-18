/**
 * 结束回合 —— ADR-0011 规定：超时由服务端会话层构造**系统 Intent**
 * `{ type: 'turn:end', actor: 'system', reason: 'timeout' }`，
 * 与玩家主动结束回合走**完全相同**的链路。本文件即该链路的实现。
 *
 * 实现方式：从当前阶段起连续调用 `advanceOnce` 直到回合号改变。
 * 不直接跳到下一回合 —— A4-2 明令阶段不可跳过，超时也不构成例外。
 */

import { RULE_ERRORS, type GameEvent, type GameState, type Intent, type Result, type Rejection, type RuleContext } from '@app/shared';

import { reduce } from '../reducer.js';
import { activePlayer } from '../state.js';
import { drawForPhase } from './draw.js';
import { advanceOnce, PHASE_ORDER } from './phase.js';

/** 安全阀：最多推进「阶段数 + 2」次，防止任何意外的不变量破坏导致死循环。 */
const MAX_STEPS = PHASE_ORDER.length + 2;

export const turnEndRule = (
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

  const events: GameEvent[] = [];
  let s = state;
  const startTurn = state.turn;

  // ADR-0023 §2：待定选择挂起时，系统链路（超时兜底）视同放弃选择 ——
  // 先自动 pass（清除挂起）再推进，否则选择会跨回合悬挂、引用已离场对象。
  if (s.pendingChoice) {
    events.push({ type: 'choice:cleared', at: ctx.now });
    s = reduce(s, events[events.length - 1]!);
  }

  for (let i = 0; i < MAX_STEPS; i++) {
    // 抽牌手动化（Era 2026-10-18）的**超时兜底**：玩家链路在「未抽牌的抽牌阶段」
    // 禁止推进（`phase.ts`），但系统链路不能卡死 —— 未抽则先自动补抽再走。
    if (s.phase === 'draw' && !s.drawnThisPhase) {
      const active = activePlayer(s);
      if (active) {
        const drawn = drawForPhase(s, active, ctx);
        events.push(...drawn);
        s = drawn.reduce(reduce, s);
      }
    }
    const step = advanceOnce(s, ctx);
    if (step.length === 0) break;
    events.push(...step);
    s = step.reduce(reduce, s);
    if (s.turn !== startTurn) break;
  }

  return { ok: true, value: events };
};
