/**
 * 出牌 —— docs/16 §3 / §4（8 血版，ADR-0024）+ A5 补充 2 / A6-1。
 *
 * 支付语义：费用是**费用区里的卡的数量**；本次支付 `costToPay(def)` 张。
 *  - 随从：卡面费用 −1（最低 0，docs/16 §4）；
 *  - 法术 / 设置法术：卡面费用（§4.1）。
 *
 * `maxCost` 校验（§3.3）：本回合**所有支付的总张数**不得超过上限
 * （各自回合数 → 1/3/5/10）。0 费不占额度。支付后发 `cost:spent` 记帐。
 *
 * 效果接线（ADR-0025）：
 *  - 随从 → `summonEntryEvents`（军师/队长触发器 + 各卡登场效果）；
 *  - 法术 → `spellEntryEvents`，结算后置入弃牌区（设置法术留在法术区）。
 */

import { BOARD_SLOTS, RULE_ERRORS } from '@app/shared/constants';
import type { GameEvent, GameState, Intent, Result, Rejection, RuleContext, Zone } from '@app/shared/types';

import { baseGuard, costToPay, ev, firstRejection, locate, moved, playerOf, replacedOut, strArg, strListArg } from '../ops.js';
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

  /*
   * 召唤位置（D-257）—— `payload.slot` 为 0 ~ BOARD_SLOTS-1。
   *
   * 语义（Era 2026-10-21）：「该位置有随从可以直接顶替，被顶替的卡进弃牌区」。
   * 所以**指定了位置就不再受「随从区已满」限制** —— 满场时的正常操作就是顶替；
   * 只有不指定位置（老客户端 / AI）时才保留原来的 BOARD_FULL 拒绝。
   */
  const slotRaw = intent.payload?.['slot'];
  let slot: number | null = null;
  if (slotRaw !== undefined && slotRaw !== null) {
    if (
      typeof slotRaw !== 'number' ||
      !Number.isInteger(slotRaw) ||
      slotRaw < 0 ||
      slotRaw >= BOARD_SLOTS
    ) {
      return {
        ok: false,
        error: { code: RULE_ERRORS.INVALID_SLOT, message: `位置必须是 0–${BOARD_SLOTS - 1} 的整数` },
      };
    }
    if (def.type !== 'minion') {
      // 给法术指定位置 = 前端把「选格子」错接到非随从上。早报错，别让它静默变成「随便放」。
      return {
        ok: false,
        error: { code: RULE_ERRORS.INVALID_SLOT, message: '只有随从需要指定位置' },
      };
    }
    slot = slotRaw;
  }

  if (dest === 'board' && slot === null && p.zones.board.length >= BOARD_SLOTS) {
    return { ok: false, error: { code: RULE_ERRORS.BOARD_FULL, message: `随从区已满（${BOARD_SLOTS}）` } };
  }

  // 随从减费（docs/16 §4）+ 星轨传令的「下一张随从费用 -1」（docs/17）。
  const basePay = costToPay(def);
  const pay = def.type === 'minion' ? Math.max(0, basePay - p.nextMinionDiscount) : basePay;

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

  /*
   * 支付用哪几张（D-257）—— `payload.costUids` 可选。
   *
   * 不传 = 沿用旧行为（按费用区顺序取前 `pay` 张），AI 与老客户端走这条；
   * 传了就必须**恰好 `pay` 张、都在己方费用区、不重复** —— 少给会让玩家白赚，
   * 多给会悄悄多丢卡，两种都必须拒绝而不是「尽力而为」。
   */
  const pick = strListArg(intent.payload?.['costUids']);
  if (pick !== null) {
    if (pick.length !== pay) {
      return {
        ok: false,
        error: {
          code: RULE_ERRORS.INVALID_COST_PICK,
          message: `需要支付 ${pay} 张，实际选了 ${pick.length} 张`,
        },
      };
    }
    const seen = new Set<string>();
    for (const u of pick) {
      if (seen.has(u)) {
        return { ok: false, error: { code: RULE_ERRORS.INVALID_COST_PICK, message: `费用卡重复：${u}` } };
      }
      if (!p.zones.cost.some((c) => c.uid === u)) {
        return {
          ok: false,
          error: { code: RULE_ERRORS.INVALID_COST_PICK, message: `${u} 不在你的费用区` },
        };
      }
      seen.add(u);
    }
  }
  const paying = pick ?? p.zones.cost.slice(0, pay).map((c) => c.uid);

  const at = ctx.now;
  const events: GameEvent[] = [];
  for (const uid of paying) {
    events.push(moved(at, intent.playerId, uid, 'cost', 'graveyard'));
  }
  if (pay > 0) events.push(ev(at, 'cost:spent', { playerId: intent.playerId, amount: pay }));
  // 星轨传令的减费只作用于**下一张**随从 —— 打出即消耗。
  if (def.type === 'minion' && p.nextMinionDiscount > 0) {
    events.push(ev(at, 'cost:discount', { playerId: intent.playerId, value: 0 }));
  }
  /*
   * 顶替（D-257）—— 指定位置先腾空。
   *
   * 顺序必须是「被顶替者离场」在前、「新卡登场」在后：
   * reducer 见到 `card:moved` 进随从区时会找空槽，如果旧卡还占着这一格，
   * 新卡就会被挤到别的格子去（玩家选了 2 号位却出现在 3 号位）。
   */
  if (dest === 'board' && slot !== null) {
    const idx = p.zones.board.findIndex((c, i) => (c.slot ?? i) === slot);
    const occupant = idx >= 0 ? p.zones.board[idx] : undefined;
    if (occupant) {
      events.push(ev(at, 'unit:replaced', { playerId: intent.playerId, slot, byUid: occupant.uid, uid }));
      events.push(replacedOut(at, intent.playerId, occupant.uid, slot));
    }
  }
  events.push(moved(at, intent.playerId, uid, 'hand', dest, slot ?? undefined));

  // 效果接线：先推演移动事件（效果读的是登场/入区后的场面）。
  const next = events.reduce(reduce, state);
  if (dest === 'board') {
    events.push(...summonEntryEvents(at, next, intent.playerId, uid, ctx));
  } else {
    events.push(...spellEntryEvents(at, next, intent.playerId, uid, ctx));
    // 普通法术结算后进弃牌区；设置法术留在法术区（提供光环 / 触发）。
    if (def.type === 'spell') {
      events.push(moved(at, intent.playerId, uid, 'spell', 'graveyard'));
    }
  }
  return { ok: true, value: events };
};
