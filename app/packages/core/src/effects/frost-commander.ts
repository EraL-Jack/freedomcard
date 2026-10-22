/**
 * 霜律裁决官（frostAdjudicator）—— docs/12 §4.1（ADR-0025）+ docs/16 §6.3（D-229）。
 *
 * ```
 * Ⅰ 每回合一次【2】：按霜痕层数冻结敌方随从（门槛于 D-290 前移，docs/16 §15 C-03）：
 *   0–1 层：冻结 1 个
 *   2–3 层：冻结 1 个，抽 1 张
 *   4–5 层：冻结 2 个
 *   6 层及以上：冻结 2 个，抽 1 张
 * Ⅱ 敌方随从被冻结时：抽 1 张（每回合最多触发 1 次）。
 * Ⅲ 敌方随从被冻结时：你获得 1 层霜痕（永久累积，不清零）。
 * ```
 *
 * Ⅱ / Ⅲ 是**被动触发**，没有发动入口；结算挂在 `primitives.freezeUnit`
 * （所有冻结来源共用，避免「某张卡的冻结不触发」）。
 *
 * Ⅰ 的「冻结 2 个」是**连续两次选择**：`pendingChoice` 只有一个槽位，
 * 故第一次选完再挂第二次，而不是一次给出两个目标 —— 这样玩家能中途放弃
 * （放弃即少冻一个，仍结算抽牌）。
 */

import { FROST_MARK_TIERS, RULE_ERRORS } from '@app/shared/constants';
import type { GameEvent, Result, Rejection } from '@app/shared/types';

import { baseGuard, ev, firstRejection, locate, playerOf, reject, strArg } from '../ops.js';

import {
  canPayCost,
  choiceCleared,
  choicePending,
  commanderSkillCost,
  effectKey,
  payCostCards,
  usedGuard,
  type EffectModule,
} from './index.js';
import { applyEvents, drawTop, enemyBoard, freezeUnit } from './primitives.js';

/** 霜痕档位：返回本次冻结几个、是否抽 1 张（docs/16 §6.3.3）。 */
export function frostTierOf(mark: number): { count: number; draw: boolean } {
  const [t1, t2, t3] = FROST_MARK_TIERS;
  if (mark >= t3) return { count: 2, draw: true };
  if (mark >= t2) return { count: 2, draw: false };
  if (mark >= t1) return { count: 1, draw: true };
  return { count: 1, draw: false };
}

/** 从待定选择里取数值 / 布尔（事件 payload 不可信，一律显式校验）。 */
function metaNum(meta: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = meta?.[key];
  return typeof v === 'number' ? v : fallback;
}

export const frostAdjudicatorEffect: EffectModule = {
  /**
   * AI 何时该发动 Ⅰ（issue #137 / D-288）。
   *
   * 判定与 `activate` **同源**：本回合没用过 Ⅰ、2 费付得起、敌方场上至少有一个
   * 未冻结的随从（H31：对已冻结者再冻结是空操作，凑不出目标就别白付 2 费）。
   * 霜痕 0 层也有一档收益（冻结 1 个），所以不设层数门槛 —— 档位表只影响收益大小。
   */
  aiCouldUse(state, ctx, owner) {
    const p = playerOf(state, owner);
    const cmd = p?.zones.commander[0];
    if (!p || !cmd) return null;
    if (usedGuard(p, cmd.uid, '1')) return null;
    if (!canPayCost(p, commanderSkillCost(p))) return null;
    if (enemyBoard(state, owner).every((c) => c.frozen)) return null;
    return { via: 'activate', effectId: '1' };
  },

  activate(state, intent, ctx, effectId): Result<GameEvent[], Rejection> {
    if (effectId !== '1') {
      return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, `未知效果: ${effectId}`);
    }
    const at = ctx.now;
    const me = intent.playerId;
    const loc = locate(state, strArg(intent.payload?.['uid']) ?? '');
    if (!loc || loc.playerId !== me || loc.zone !== 'commander') {
      return reject(RULE_ERRORS.CARD_NOT_IN_ZONE, '效果来源必须是你的指挥官');
    }
    const p = playerOf(state, me);
    if (!p) return reject(RULE_ERRORS.NOT_YOUR_TURN, '玩家不在本局');

    const g = firstRejection(baseGuard(state, intent), usedGuard(p, loc.card.uid, '1'));
    if (g) return { ok: false, error: g };

    // H31：只列未冻结的敌方随从（对已冻结者再冻结不算「被冻结」）。
    const targets = enemyBoard(state, me)
      .filter((c) => !c.frozen)
      .map((c) => c.uid);
    if (targets.length === 0) {
      return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, '对方场上没有可冻结的随从');
    }
    const pay = payCostCards(at, me, p, commanderSkillCost(p));
    if (!Array.isArray(pay)) return { ok: false, error: pay };

    const tier = frostTierOf(p.frostMark);
    return {
      ok: true,
      value: [
        ...pay,
        ev(at, 'effect:used', { playerId: me, key: effectKey(loc.card.uid, '1') }),
        choicePending(at, {
          playerId: me,
          kind: 'frost-adjudicator-1',
          sourceUid: loc.card.uid,
          options: targets,
          meta: { count: tier.count, draw: tier.draw, picked: [] },
        }),
      ],
    };
  },

  choose(state, intent, ctx, pending): Result<GameEvent[], Rejection> {
    if (pending.kind !== 'frost-adjudicator-1') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的裁决官选择');
    }
    const at = ctx.now;
    const me = intent.playerId;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    const need = metaNum(pending.meta, 'count', 1);
    const wantsDraw = pending.meta?.['draw'] === true;
    const pickedRaw = pending.meta?.['picked'];
    const picked = Array.isArray(pickedRaw) ? pickedRaw.filter((x) => typeof x === 'string') : [];
    const meP = state.players[me];

    /** 收尾：需要时抽 1 张，然后清掉待定选择。 */
    const finish = (events: GameEvent[]): Result<GameEvent[], Rejection> => {
      const out = [...events];
      // ⚠️ 抽牌必须基于**已结算冻结之后**的状态：冻结会触发裁决官Ⅱ抽 1 张，
      // 若仍用入参 `state` 算牌库顶，抽到的 uid 与真实牌序脱节（事件变成空操作）。
      if (wantsDraw && meP) out.push(...drawTop(at, applyEvents(state, events), me, 1).events);
      out.push(choiceCleared(at));
      return { ok: true, value: out };
    };

    if (choice === 'pass') return finish([]);
    if (!pending.options.includes(choice)) {
      return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
    }

    const frozen = freezeUnit(at, state, me, choice, ctx.cards);
    const nextPicked = [...picked, choice];
    // 还需要冻第二个、且场上还有别的目标 → 再挂一次选择（剩余目标 = 去掉已冻的）。
    const rest = pending.options.filter((uid) => !nextPicked.includes(uid));
    if (nextPicked.length < need && rest.length > 0) {
      return {
        ok: true,
        value: [
          ...frozen.events,
          choicePending(at, {
            playerId: me,
            kind: 'frost-adjudicator-1',
            sourceUid: pending.sourceUid,
            options: rest,
            meta: { ...pending.meta, picked: nextPicked },
          }),
        ],
      };
    }
    return finish(frozen.events);
  },
};
