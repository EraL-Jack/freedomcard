/**
 * 出牌 —— `docs/06` A5 补充 2 + A6-1 + A9-1。
 *
 * 支付语义（A5 补充 2）：把**足够数量的卡**从费用区置入弃牌区，数量不足则无法支付。
 * 所以「费用」不是数值资源池，而是**费用区里的卡的数量**；`cost` 是本次要消耗的张数。
 *
 * ⚠️ 两处刻意留空，均属 Era 未给输入，不得自行发明：
 *  1. **最高费用（`maxCost`）的上限语义未定** —— A5-2 给了增长曲线 1→3→5→10，
 *     但没说是「单卡 cost 上限」还是「本回合可消耗的总张数上限」。
 *     本文件只**按张数支付**，不施加 `maxCost` 限制；`maxCost` 仍按曲线推进并存于状态，
 *     待 Era 明确后再补这条校验（改动只落在本文件）。
 *  2. **法术 / 持续法术的效果结算未定** —— A6-3 字段清单与效果定义都没给。
 *     本文件只把卡放进 `spell` 区，**不执行任何效果**。
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

import { baseGuard, firstRejection, locate, moved, playerOf, strArg } from '../ops.js';
import { reduce } from '../reducer.js';
import { bladeSummonTriggerEvents } from '../effects/index.js';
import { bladeOrderResolution } from '../effects/blade-order.js';

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

  // A5 补充 2：从费用区取 `cost` 张送入弃牌区，不足则拒绝
  if (p.zones.cost.length < def.cost) {
    return {
      ok: false,
      error: {
        code: RULE_ERRORS.INSUFFICIENT_COST,
        message: `费用不足：需要 ${def.cost} 张，费用区仅有 ${p.zones.cost.length} 张`,
      },
    };
  }

  const at = ctx.now;
  const events: GameEvent[] = [];
  for (let i = 0; i < def.cost; i++) {
    events.push(moved(at, intent.playerId, p.zones.cost[i]!.uid, 'cost', 'graveyard'));
  }
  events.push(moved(at, intent.playerId, uid, 'hand', dest));

  // ADR-0023 §7：登场触发器 —— 炎刃随从登场时结算军师的「本回合 +1」。
  // 注意先推演移动事件再判触发（触发器读的是登场后的场面）。
  if (dest === 'board') {
    const next = events.reduce(reduce, state);
    events.push(...bladeSummonTriggerEvents(at, next, intent.playerId, uid, ctx.cards));
  }
  // ADR-0023 §6：号令法术出牌即结算 —— 展示卡组顶 7 张并挂起待定选择。
  if (def.defId === 'bladeOrder') {
    const next = events.reduce(reduce, state);
    events.push(...bladeOrderResolution(at, next, ctx, intent.playerId, uid));
  }
  return { ok: true, value: events };
};
