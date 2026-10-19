/**
 * 霜律裁决官（frostAdjudicator）—— docs/12 §4.1（ADR-0025）。
 *
 * Ⅰ 【2】每回合一次：霜冻一个敌方随从。
 * Ⅱ 每回合一次：当一个敌方随从被霜冻时，抽一张牌。
 *
 * Ⅱ 是**被动触发**，没有发动入口；结算挂在 `primitives.freezeUnit`
 * （所有霜冻来源共用，避免「某张卡的冻结不触发」）。
 */

import {
  RULE_ERRORS,
  type GameEvent,
  type Result,
  type Rejection,
} from '@app/shared';

import { baseGuard, ev, firstRejection, locate, playerOf, reject, strArg } from '../ops.js';

import {
  choiceCleared,
  choicePending,
  commanderSkillCost,
  effectKey,
  payCostCards,
  usedGuard,
  type EffectModule,
} from './index.js';
import { enemyBoard, freezeUnit } from './primitives.js';

export const frostAdjudicatorEffect: EffectModule = {
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

    const targets = enemyBoard(state, me).map((c) => c.uid);
    if (targets.length === 0) {
      return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, '对方场上没有随从可冻结');
    }
    const pay = payCostCards(at, me, p, commanderSkillCost(p));
    if (!Array.isArray(pay)) return { ok: false, error: pay };

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
        }),
      ],
    };
  },

  choose(state, intent, ctx, pending): Result<GameEvent[], Rejection> {
    if (pending.kind !== 'frost-adjudicator-1') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的裁决官选择');
    }
    const at = ctx.now;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    if (choice === 'pass') return { ok: true, value: [choiceCleared(at)] };
    if (!pending.options.includes(choice)) {
      return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
    }
    const frozen = freezeUnit(at, state, intent.playerId, choice, ctx.cards);
    return { ok: true, value: [...frozen.events, choiceCleared(at)] };
  },
};
