/**
 * 炎刃军师（bladeTactician）— ADR-0023 §7。
 *
 * 卡面原文：每回合一次，这张卡在场时，这个回合获得效果【每当有一个【炎刃】随从登场，
 * 那个随从力量值+1，这个效果这个回合最多发动次数为指挥官当前除外区的炎刃个数】。
 *
 * 实现：发动 = 挂一个 `on-blade-summon` 回合触发器（次数 = 发动时除外区炎刃数）；
 * 触发结算在 `bladeSummonTriggerEvents`（出牌与效果召唤共用，见 effects/index.ts）。
 * 「这张卡在场时」→ 发动时必须在随从区；触发器不随军师离场回收（回合末统一清空，
 * 卡面未说离场失效 —— 登记为留白假设 H24）。
 */

import {
  RULE_ERRORS,
  type GameEvent,
  type Result,
  type Rejection,
} from '@app/shared';

import { baseGuard, ev, firstRejection, locate, playerOf, reject, strArg } from '../ops.js';

import {
  bladeExileCount,
  effectKey,
  usedGuard,
  type EffectModule,
} from './index.js';

export const bladeTacticianEffect: EffectModule = {
  activate(state, intent, ctx, effectId): Result<GameEvent[], Rejection> {
    if (effectId !== '1') {
      return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, `未知效果: ${effectId}`);
    }
    const me = intent.playerId;
    const uid = strArg(intent.payload?.['uid']) ?? '';
    const loc = locate(state, uid);
    if (!loc || loc.playerId !== me || loc.zone !== 'board') {
      return reject(RULE_ERRORS.CARD_NOT_IN_ZONE, '军师必须在随从区才能发动');
    }
    const p = playerOf(state, me);
    if (!p) return reject(RULE_ERRORS.NOT_YOUR_TURN, '玩家不在本局');
    const g = firstRejection(baseGuard(state, intent), usedGuard(p, uid, '1'));
    if (g) return { ok: false, error: g };

    const count = bladeExileCount(p, ctx.cards);
    return {
      ok: true,
      value: [
        ev(ctx.now, 'effect:used', { playerId: me, key: effectKey(uid, '1') }),
        ev(ctx.now, 'trigger:added', {
          playerId: me,
          trigger: { sourceUid: uid, owner: me, kind: 'on-blade-summon', remaining: count },
        }),
      ],
    };
  },
};
