/**
 * 出牌 —— docs/16 §3 / §4（8 血版，ADR-0024）+ A5 补充 2 / A6-1。
 *
 * 支付语义：费用是**费用区里的卡的数量**；本次支付 `costToPay(def)` 张。
 *  - 随从：卡面费用 −1（最低 0，docs/16 §4）；
 *  - 法术 / 持续法术：卡面费用（§4.1）。
 *
 * `maxCost` 校验（§3.3）：本回合**所有支付的总张数**不得超过上限
 * （各自回合数 → 1/3/5/10）。0 费不占额度。支付后发 `cost:spent` 记帐。
 *
 * 效果接线（ADR-0025）：
 *  - 随从 → `summonEntryEvents`（军师/队长触发器 + 各卡登场效果）；
 *  - 法术 → `spellEntryEvents`，结算后置入墓地（持续法术留在法术区）。
 */

import {
  BOARD_SLOTS,
  RULE_ERRORS,
  type GameEvent,
  type GameState,
  type Intent,
  type Result,
  type Rejection,
  type RuleContext,
  type Zone,
} from '@app/shared';

import { baseGuard, costToPay, ev, firstRejection, locate, moved, playerOf, strArg } from '../ops.js';
import { reduce } from '../reducer.js';
import { spellEntryEvents, summonEntryEvents } from '../effects/index.js';

export const playRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  const guard = firstRejection(
    baseGuard(state, intent),
    state.phase !== 'main' ? { code: RULE_ERRORS.WRONG_PHASE, message: '出牌只在主要阶段进行' } : null,
  );
  if (guard) return { ok: false, error: guard };

  const uid = strArg(intent.payload?.uid);
  if (!uid) {
    return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: '缺少 uid' } };
  }
  const loc = locate(state, uid);
  if (!loc || loc.playerId !== intent.playerId || loc.zone !== 'hand') {
    return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: `${uid} 不在你的手牌` } };
  }

  const def = ctx.cards[loc.card.defId];
  if (!def) {
    return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_FOUND, message: `卡定义缺失: ${loc.card.defId}` } };
  }
  if (def.type === 'commander') {
    return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: '指挥官不通过手牌打出（X-1 揭示入区）' } };
  }

  const p = playerOf(state, intent.playerId);
  if (!p) return { ok: false, error: { code: RULE_ERRORS.NOT_YOUR_TURN, message: '玩家不在本局' } };

  const dest: Zone = def.type === 'minion' ? 'board' : 'spell';
  if (dest === 'board' && p.zones.board.length >= BOARD_SLOTS) {
    return { ok: false, error: { code: RULE_ERRORS.BOARD_FULL, message: `随从区已满（${BOARD_SLOTS}）` } };
  }

  const pay = costToPay(def);

  // A5 补充 2：费用区张数必须够
  if (p.zones.cost.length < pay) {
    return {
      ok: false,
      error: {
        code: RULE_ERRORS.INSUFFICIENT_COST,
        message: `费用不足：需要 ${pay} 张，费用区仅有 ${p.zones.cost.length} 张`,
      },
    };
  }
  // docs/16 §3.3：本回合总消耗上限（0 费不占额度）
  if (pay > 0 && p.usedCostThisTurn + pay > p.maxCost) {
    return {
      ok: false,
      error: {
        code: RULE_ERRORS.MAX_COST_EXCEEDED,
        message: `本回合费用上限 ${p.maxCost} 张，已用 ${p.usedCostThisTurn} 张`,
      },
    };
  }

  const at = ctx.now;
  const events: GameEvent[] = [];
  for (let i = 0; i < pay; i++) {
    events.push(moved(at, intent.playerId, p.zones.cost[i]!.uid, 'cost', 'graveyard'));
  }
  if (pay > 0) events.push(ev(at, 'cost:spent', { playerId: intent.playerId, amount: pay }));
  events.push(moved(at, intent.playerId, uid, 'hand', dest));

  // 效果接线：先推演移动事件（效果读的是登场/入区后的场面）。
  const next = events.reduce(reduce, state);
  if (dest === 'board') {
    events.push(...summonEntryEvents(at, next, intent.playerId, uid, ctx));
  } else {
    events.push(...spellEntryEvents(at, next, intent.playerId, uid, ctx));
    // 普通法术结算后进墓地；持续法术留在法术区（提供光环 / 触发）。
    if (def.type === 'spell') {
      events.push(moved(at, intent.playerId, uid, 'spell', 'graveyard'));
    }
  }
  return { ok: true, value: events };
};
