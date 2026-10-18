/**
 * 效果发动 / 待定选择回答 —— ADR-0023 §1。
 *
 * 两个 Intent 一个文件：它们是同一机制的两半（发动挂起选择，回答继续结算）。
 * 具体卡的效果在 `core/src/effects/` 注册表派发，本文件只做通用校验与分发。
 */

import {
  RULE_ERRORS,
  type GameEvent,
  type GameState,
  type Intent,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import { baseGuard, locate, reject, strArg } from '../ops.js';

import { EFFECTS, EFFECTS_BY_KIND } from '../effects/index.js';

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
  if (!module) {
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
  return module.choose(state, intent, ctx, pending);
};
