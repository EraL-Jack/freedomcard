/**
 * 充能 —— `docs/06` 自定义条目 X-2：充能阶段可将**场上或手牌任意数量**的随从
 * 置入费用区。
 *
 * 「充能区」即「费用区」：Era 2026-10-13 确认二者同一，实现只建 `cost` 一个区
 * （ADR-0012）。这是资源循环的核心入口 —— 费用区里的卡用于支付（见 `play.ts`）。
 */

import { RULE_ERRORS } from '@app/shared/constants';
import type { CardDef, GameEvent, GameState, Intent, Result, Rejection, RuleContext } from '@app/shared/types';

import { baseGuard, firstRejection, locate, moved, strListArg } from '../ops.js';

export const chargeRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  const guard = firstRejection(
    baseGuard(state, intent),
    state.phase !== 'charge' ? { code: RULE_ERRORS.WRONG_PHASE, message: '充能只在充能阶段进行' } : null,
  );
  if (guard) return { ok: false, error: guard };

  const uids = strListArg(intent.payload?.uids);
  if (!uids) {
    return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: 'uids 必须是 uid 数组' } };
  }

  const at = ctx.now;
  const events: GameEvent[] = [];

  for (const uid of uids) {
    const loc = locate(state, uid);
    if (!loc || loc.playerId !== intent.playerId || (loc.zone !== 'hand' && loc.zone !== 'board')) {
      return {
        ok: false,
        error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: `${uid} 不在你的手牌或场上` },
      };
    }
    const def: CardDef | undefined = ctx.cards[loc.card.defId];
    if (!def) {
      return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_FOUND, message: `卡定义缺失: ${loc.card.defId}` } };
    }
    // X-2 原文限定「随从」
    if (def.type !== 'minion') {
      return {
        ok: false,
        error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: `只有随从可以充能: ${def.type}` },
      };
    }
    events.push(moved(at, intent.playerId, uid, loc.zone, 'cost'));
  }

  return { ok: true, value: events };
};
