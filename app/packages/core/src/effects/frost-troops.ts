/**
 * 霜律随从的效果 —— docs/12 §4（ADR-0025）。
 *
 * 覆盖：学徒 / 缚锁者 / 守夜人 / 典狱长 / 凛冬之刃的登场冻结，
 * 以及多目标冻结的选择流程。
 *
 * 没有模块的三张：
 *  - 新兵（白板）；
 *  - 戍卫（被攻击时攻击者 −1）—— 结算在 `rules/attack.ts` 的力量快照前；
 *  - 长枪兵（攻击霜冻目标 +2）—— 同上，一次性修正；
 *  - 执法者（被霜冻时成长）—— 结算在 `primitives.freezeUnit`。
 */

import {
  RULE_ERRORS,
  type GameEvent,
  type GameState,
  type PendingChoice,
  type PlayerId,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import { reject, strArg } from '../ops.js';

import { choiceCleared, choicePending, type EffectModule } from './index.js';
import { drawTop, emitter, enemyBoard, freezeUnit } from './primitives.js';

/** 多目标冻结：一次挂起一个，meta 记剩余次数与已选目标。 */
function multiFreezeChoice(
  at: number,
  state: GameState,
  me: PlayerId,
  sourceUid: string,
  kind: string,
  remaining: number,
  used: string[],
): GameEvent {
  const options = enemyBoard(state, me)
    .map((c) => c.uid)
    .filter((u) => !used.includes(u));
  if (remaining <= 0 || options.length === 0) return choiceCleared(at);
  return choicePending(at, { playerId: me, kind, sourceUid, options, meta: { remaining, used } });
}

/** 多目标冻结的回答（守夜人 / 寒流共用）。 */
function multiFreezeChoose(
  state: GameState,
  intent: Parameters<NonNullable<EffectModule['choose']>>[1],
  ctx: RuleContext,
  pending: PendingChoice,
): Result<GameEvent[], Rejection> {
  const at = ctx.now;
  const me = intent.playerId;
  const choice = strArg(intent.payload?.['choice']) ?? '';
  if (choice === 'pass') return { ok: true, value: [choiceCleared(at)] };
  if (!pending.options.includes(choice)) {
    return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
  }
  const remaining = typeof pending.meta?.['remaining'] === 'number' ? pending.meta['remaining'] : 0;
  const used = Array.isArray(pending.meta?.['used']) ? (pending.meta['used'] as string[]) : [];

  const frozen = freezeUnit(at, state, me, choice, ctx.cards);
  const events = [...frozen.events];
  events.push(
    multiFreezeChoice(
      at,
      frozen.state,
      me,
      pending.sourceUid,
      pending.kind,
      remaining - 1,
      [...used, choice],
    ),
  );
  return { ok: true, value: events };
}

/* --------------------------- 霜律学徒 --------------------------- */

export const frostApprenticeEffect: EffectModule = {
  onSummon(state, ctx, owner, uid) {
    const targets = enemyBoard(state, owner).map((c) => c.uid);
    if (targets.length === 0) return [];
    return [
      choicePending(ctx.now, {
        playerId: owner,
        kind: 'frost-apprentice-freeze',
        sourceUid: uid,
        options: targets,
      }),
    ];
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'frost-apprentice-freeze') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的学徒选择');
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

/* --------------------------- 霜律缚锁者 --------------------------- */

/** 登场时：霜冻一个敌方随从；若该随从已霜冻，改为抽一张牌。 */
export const frostBinderEffect: EffectModule = {
  onSummon(state, ctx, owner, uid) {
    const targets = enemyBoard(state, owner).map((c) => c.uid);
    if (targets.length === 0) return [];
    return [
      choicePending(ctx.now, {
        playerId: owner,
        kind: 'frost-binder-freeze',
        sourceUid: uid,
        options: targets,
      }),
    ];
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'frost-binder-freeze') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的缚锁者选择');
    }
    const at = ctx.now;
    const me = intent.playerId;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    if (choice === 'pass') return { ok: true, value: [choiceCleared(at)] };
    if (!pending.options.includes(choice)) {
      return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
    }
    const foe = state.seats.find((x) => x !== me);
    const target = foe ? state.players[foe]?.zones.board.find((c) => c.uid === choice) : undefined;
    if (target?.frozen) {
      const drawn = drawTop(at, state, me, 1);
      return { ok: true, value: [...drawn.events, choiceCleared(at)] };
    }
    const frozen = freezeUnit(at, state, me, choice, ctx.cards);
    return { ok: true, value: [...frozen.events, choiceCleared(at)] };
  },
};

/* --------------------------- 霜律守夜人 --------------------------- */

/** 登场时：霜冻至多两个敌方随从。 */
export const frostNightwatchEffect: EffectModule = {
  onSummon(state, ctx, owner, uid) {
    const targets = enemyBoard(state, owner);
    if (targets.length === 0) return [];
    return [
      choicePending(ctx.now, {
        playerId: owner,
        kind: 'frost-nightwatch-freeze',
        sourceUid: uid,
        options: targets.map((c) => c.uid),
        meta: { remaining: 2, used: [] },
      }),
    ];
  },
  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'frost-nightwatch-freeze') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的守夜人选择');
    }
    return multiFreezeChoose(state, intent, ctx, pending);
  },
};

/* --------------------------- 典狱长 / 凛冬之刃 --------------------------- */

/** 登场时：霜冻所有敌方随从（逐张结算，触发裁决官Ⅱ / 执法者）。 */
function freezeAllOnSummon(state: GameState, ctx: RuleContext, owner: PlayerId): GameEvent[] {
  const e = emitter(state);
  for (const c of enemyBoard(state, owner)) {
    const r = freezeUnit(ctx.now, e.state, owner, c.uid, ctx.cards);
    e.push(...r.events);
  }
  return e.events;
}

export const frostJailerEffect: EffectModule = {
  onSummon(state, ctx, owner) {
    return freezeAllOnSummon(state, ctx, owner);
  },
};

export const frostWinterbladeEffect: EffectModule = {
  onSummon(state, ctx, owner) {
    return freezeAllOnSummon(state, ctx, owner);
  },
};
