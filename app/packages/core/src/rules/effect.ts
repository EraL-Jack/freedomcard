/**
 * 效果发动 / 待定选择回答 —— ADR-0023 §1。
 *
 * 两个 Intent 一个文件：它们是同一机制的两半（发动挂起选择，回答继续结算）。
 * 具体卡的效果在 `core/src/effects/` 注册表派发，本文件只做通用校验与分发。
 */

import { RULE_ERRORS } from '@app/shared/constants';
import type { GameEvent, GameState, Intent, Result, Rejection, RuleContext } from '@app/shared/types';

import { baseGuard, ev, locate, reject, strArg } from '../ops.js';

import { EFFECTS, EFFECTS_BY_KIND, choiceCleared, choicePending } from '../effects/index.js';

/**
 * 选择链收尾 —— 若本次结算**没有**再挂新选择（链已结束），且队列非空，则出队重新挂起。
 *
 * H28 / ADR-0031：效果召唤在选择链中产生的登场选择不能立刻挂（会覆盖当前选择），
 * 一律入队；此处是**唯一的出队点**，保证「上一轮所有待结算效果结束后，下一轮时点触发」。
 * 对局已结束时不出队（没有玩家还能回答）。
 */
function promoteQueuedChoice(
  state: GameState,
  events: GameEvent[],
  ctx: RuleContext,
): GameEvent[] {
  if (events.some((e) => e.type === 'choice:pending' || e.type === 'game:ended')) return events;
  const head = state.pendingChoiceQueue[0];
  if (!head) return events;
  return [...events, ev(ctx.now, 'choice:dequeued'), choicePending(ctx.now, head)];
}

/**
 * 选择链收尾（D-260）—— 本次回答若**既没有挂新选择、也没有自己收尾**，就由这里补一条
 * `choice:cleared`。
 *
 * ## 为什么收尾要放在唯一入口
 *
 * 各效果模块的 `choose` 都要在返回值末尾自己 `choiceCleared(at)`，漏一次就是灾难：
 * issue #88（炎刃骑士）漏了这一步，攻击结算完 `pendingChoice` 一直挂着 ——
 * 选择面板关不掉，玩家点任何别的操作都被「请先回答选择」挡住，整局卡死；
 * 而面板里残留的选项还能再点，每点一次加一次力量。
 *
 * 这类「漏一行就死锁」的契约不该靠每个模块自觉。放在规则层兜底后：
 *  - 主动写了 `choiceCleared` 的模块行为完全不变（不重复补）；
 *  - 漏写的模块只是少了一次显式收尾，不会把对局卡进死状态。
 */
function settleChoice(
  state: GameState,
  events: GameEvent[],
  ctx: RuleContext,
): GameEvent[] {
  const handled = events.some(
    (e) => e.type === 'choice:pending' || e.type === 'choice:cleared' || e.type === 'game:ended',
  );
  return promoteQueuedChoice(state, handled ? events : [...events, choiceCleared(ctx.now)], ctx);
}

/** 发动卡面效果。 */
export const effectActivateRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  const g = baseGuard(state, intent);
  if (g) return { ok: false, error: g };

  const uid = strArg(intent.payload?.['uid']);
  const effectId = strArg(intent.payload?.['effect']);
  if (!uid || !effectId) {
    return reject(RULE_ERRORS.INVALID_CHOICE, '缺少 uid / effect');
  }
  const loc = locate(state, uid);
  if (!loc || loc.playerId !== intent.playerId) {
    return reject(RULE_ERRORS.CARD_NOT_IN_ZONE, '只能发动自己卡牌的效果');
  }
  const module = EFFECTS[loc.card.defId];
  if (!module?.activate) {
    return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, '这张卡没有可发动的效果');
  }
  return module.activate(state, intent, ctx, effectId);
};

/** 回答待定选择。 */
export const effectChooseRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  const pending = state.pendingChoice;
  if (!pending) {
    return reject(RULE_ERRORS.INVALID_CHOICE, '当前没有待回答的选择');
  }
  if (pending.playerId !== intent.playerId) {
    return reject(RULE_ERRORS.NOT_YOUR_TURN, '该由对方回答');
  }
  const module = EFFECTS_BY_KIND[pending.kind];
  if (!module?.choose) {
    return reject(RULE_ERRORS.NOT_IMPLEMENTED, `未知的选择类型: ${pending.kind}`);
  }
  const res = module.choose(state, intent, ctx, pending);
  if (!res.ok) return res;
  return { ok: true, value: settleChoice(state, res.value, ctx) };
};
