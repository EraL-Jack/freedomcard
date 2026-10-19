/**
 * 霜律法术 —— docs/12 §4.5（ADR-0025）。
 *
 * 律令（冻结 + 条件抽） / 寒流（至多两个） / 审判（条件破坏） / 终裁（群体条件破坏 + 烧脸）。
 * 寒域 `frostDomain` 没有模块：它是静态光环，结算在 `ops.unitPower`。
 */

import {
  RULE_ERRORS,
  type GameEvent,
  type Result,
  type Rejection,
} from '@app/shared';

import { commanderDamageEvents } from '../combat.js';
import { moved, reject, strArg, unitPower } from '../ops.js';

import { choiceCleared, choicePending, type EffectModule } from './index.js';
import { drawTop, emitter, enemyBoard, freezeUnit } from './primitives.js';

/* --------------------------- 霜律律令 --------------------------- */

export const frostEdictEffect: EffectModule = {
  onPlay(state, ctx, owner, uid) {
    const targets = enemyBoard(state, owner).map((c) => c.uid);
    if (targets.length === 0) return [];
    return [
      choicePending(ctx.now, {
        playerId: owner,
        kind: 'frost-edict-freeze',
        sourceUid: uid,
        options: targets,
      }),
    ];
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'frost-edict-freeze') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的律令选择');
    }
    const at = ctx.now;
    const me = intent.playerId;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    if (choice === 'pass') return { ok: true, value: [choiceCleared(at)] };
    if (!pending.options.includes(choice)) {
      return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
    }
    const power = unitPower(state, ctx.cards, choice) ?? 0;
    const frozen = freezeUnit(at, state, me, choice, ctx.cards);
    const events = [...frozen.events];
    // 卡面：若其力量值 ≥ 4，抽一张。
    if (power >= 4) {
      const drawn = drawTop(at, frozen.state, me, 1);
      events.push(...drawn.events);
    }
    events.push(choiceCleared(at));
    return { ok: true, value: events };
  },
};

/* --------------------------- 霜律寒流 --------------------------- */

export const frostColdSnapEffect: EffectModule = {
  onPlay(state, ctx, owner, uid) {
    const targets = enemyBoard(state, owner);
    if (targets.length === 0) return [];
    return [
      choicePending(ctx.now, {
        playerId: owner,
        kind: 'frost-coldsnap-freeze',
        sourceUid: uid,
        options: targets.map((c) => c.uid),
        meta: { remaining: 2, used: [] },
      }),
    ];
  },

  choose(state, intent, ctx, pending): Result<GameEvent[], Rejection> {
    if (pending.kind !== 'frost-coldsnap-freeze') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的寒流选择');
    }
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
    const nextUsed = [...used, choice];
    const options = enemyBoard(frozen.state, me)
      .map((c) => c.uid)
      .filter((u) => !nextUsed.includes(u));
    if (remaining - 1 > 0 && options.length > 0) {
      events.push(
        choicePending(at, {
          playerId: me,
          kind: 'frost-coldsnap-freeze',
          sourceUid: pending.sourceUid,
          options,
          meta: { remaining: remaining - 1, used: nextUsed },
        }),
      );
    } else {
      events.push(choiceCleared(at));
    }
    return { ok: true, value: events };
  },
};

/* --------------------------- 霜律审判 --------------------------- */

export const frostJudgmentEffect: EffectModule = {
  onPlay(state, ctx, owner, uid) {
    const targets = enemyBoard(state, owner).map((c) => c.uid);
    if (targets.length === 0) return [];
    return [
      choicePending(ctx.now, {
        playerId: owner,
        kind: 'frost-judgment-target',
        sourceUid: uid,
        options: targets,
      }),
    ];
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'frost-judgment-target') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的审判选择');
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
    if (!target || !foe) return { ok: true, value: [choiceCleared(at)] };

    if (target.frozen) {
      return {
        ok: true,
        value: [moved(at, foe, choice, 'board', 'graveyard'), choiceCleared(at)],
      };
    }
    const frozen = freezeUnit(at, state, me, choice, ctx.cards);
    return { ok: true, value: [...frozen.events, choiceCleared(at)] };
  },
};

/* --------------------------- 霜律终裁 --------------------------- */

export const frostFinalJudgmentEffect: EffectModule = {
  onPlay(state, ctx, owner, uid) {
    const me = owner;
    const foe = state.seats.find((x) => x !== me);
    if (!foe) return [];
    const e = emitter(state);
    // 快照：只处理施放时已霜冻的敌方随从（新冻上的不在此列）。
    const targets = enemyBoard(state, me).filter((c) => c.frozen);
    for (const c of targets) {
      e.push(moved(ctx.now, foe, c.uid, 'board', 'graveyard'));
      e.push(...commanderDamageEvents(ctx.now, e.state, foe, 1, uid, me));
    }
    return e.events;
  },
};
