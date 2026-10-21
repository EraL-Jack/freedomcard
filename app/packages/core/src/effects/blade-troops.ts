/**
 * 炎刃随从的效果 —— docs/12 §2（ADR-0025）。
 *
 * 覆盖：卫士（登场磨牌+可选除外）、骑士（攻击时弃牌区换力量）、老兵（登场可选除外加抽牌）、
 * 勇士（登场按除外数成长）、凤凰（登场清空弃牌区炎刃并成长）。
 *
 * 队长（bladeCaptain）没有自己的模块：它是**登场时的静态光环**，
 * 结算挂在 `effects/index.ts` 的 `bladeSummonTriggerEvents`（与军师同一时点）。
 */

import type { CardDef, GameState, PlayerId } from '@app/shared/types';
import { isBladeCard } from '@app/shared/cards';

import { ev, reject, strArg } from '../ops.js';
import { resolveAttackEvents } from '../rules/attack.js';

import {
  bladeExileCount,
  choiceCleared,
  choicePending,
  type EffectModule,
} from './index.js';
import { applyEvents, drawTop, emitter, exileCard, millTop } from './primitives.js';

/** 同一玩家弃牌区里的炎刃卡 uid（卫士 / 老兵 / 骑士共用）。 */
function bladeInGraveyard(
  state: GameState,
  playerId: PlayerId,
  cards: Record<string, CardDef>,
): string[] {
  const p = state.players[playerId];
  if (!p) return [];
  return p.zones.graveyard
    .filter((c) => {
      const def = cards[c.defId];
      return def !== undefined && isBladeCard(def);
    })
    .map((c) => c.uid);
}

/* --------------------------- 炎刃卫士 bladeGuard --------------------------- */

/**
 * 登场时：将卡组顶一张卡置入弃牌区；若该卡卡名包含「炎刃」，你可以将其除外。
 * 磨牌是强制的，除外是可选的（需要选择）。
 */
export const bladeGuardEffect: EffectModule = {
  onSummon(state, ctx, owner, uid) {
    const at = ctx.now;
    const milled = millTop(at, state, owner, 1, 'graveyard');
    const events = [...milled.events];
    const card = milled.taken[0];
    const def = card ? ctx.cards[card.defId] : undefined;
    if (card && def && isBladeCard(def)) {
      events.push(
        choicePending(at, {
          playerId: owner,
          kind: 'blade-guard-exile',
          sourceUid: uid,
          options: [card.uid],
        }),
      );
    }
    return events;
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'blade-guard-exile') {
      return reject('INVALID_CHOICE', '未知的卫士选择');
    }
    const at = ctx.now;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    if (choice === 'pass') return { ok: true, value: [choiceCleared(at)] };
    if (!pending.options.includes(choice)) {
      return reject('INVALID_CHOICE', '不在可选范围');
    }
    const r = exileCard(at, state, intent.playerId, choice, ctx.cards);
    return { ok: true, value: [...r.events, choiceCleared(at)] };
  },
};

/* --------------------------- 炎刃骑士 bladeKnight --------------------------- */

/**
 * 攻击时：你可以将弃牌区一张炎刃卡除外；若如此做，本回合此卡力量值 +1。
 *
 * 攻击被拆成两段：`attack.ts` 先挂起选择（kind `blade-knight-attack`），
 * 回答后由本模块调用 `resolveAttackEvents` 完成裁决。
 */
export const bladeKnightEffect: EffectModule = {
  onSummon() {
    return [];
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'blade-knight-attack') {
      return reject('INVALID_CHOICE', '未知的骑士选择');
    }
    const at = ctx.now;
    const me = intent.playerId;
    const attackerUid = String(pending.meta?.['attackerUid'] ?? '');
    const targetUid = String(pending.meta?.['targetUid'] ?? '');
    const choice = strArg(intent.payload?.['choice']) ?? '';

    if (choice === 'pass') {
      return {
        ok: true,
        value: [
          ...resolveAttackEvents(state, ctx, { me, foe: state.seats.find((x) => x !== me) ?? '', attackerUid, targetUid }),
          // D-260：必须收尾，否则选择面板永远不消失（见下方长注释）。
          choiceCleared(at),
        ],
      };
    }
    if (!pending.options.includes(choice)) {
      return reject('INVALID_CHOICE', '不在可选范围');
    }
    /*
     * D-260：选项是**挂起那一刻**的快照，回答时那张卡可能已经不在弃牌区了
     * （面板没关时的重复点击、或链中先被别的效果除外）。此时必须拒绝 ——
     * 原来 `exileCard` 对已除外的卡会产出「exile→exile」的空移动，
     * 调用方仍照算 +1，于是同一个选择能无限叠加力量（Era 报的死锁就是这个）。
     */

    if (!state.players[me]?.zones.graveyard.some((c) => c.uid === choice)) {
      return reject('INVALID_CHOICE', '该卡已不在弃牌区');
    }

    const exiled = exileCard(at, state, me, choice, ctx.cards);
    const mod = ev(at, 'unit:modified', { playerId: me, uid: attackerUid, tempPower: 1 });
    const after = applyEvents(exiled.state, [mod]);
    // tempPower 已写入状态，本次裁决自然读到 +1（不再额外传 extraPower）。
    const hit = resolveAttackEvents(after, ctx, {
      me,
      foe: state.seats.find((x) => x !== me) ?? '',
      attackerUid,
      targetUid,
    });
    /*
     * D-260（Era issue #88）：`choiceCleared` 原来漏了 —— 攻击结算完 `pendingChoice`
     * 一直是这条 blade-knight-attack，界面上的选择面板关不掉，玩家被卡死；
     * 而且面板里的残留选项还能继续点，每点一次走一遍「除外 + 力量 +1」。
     * 现在两处都补上，且 `effectChooseRule` 另加了一层兜底（见 rules/effect.ts）。
     */
    return { ok: true, value: [...exiled.events, mod, ...hit, choiceCleared(at)] };
  },
};

/* --------------------------- 炎刃老兵 bladeVeteran --------------------------- */

/** 登场时：你可以将弃牌区一张炎刃卡除外；若如此做，抽一张牌。 */
export const bladeVeteranEffect: EffectModule = {
  onSummon(state, ctx, owner, uid) {
    const options = bladeInGraveyard(state, owner, ctx.cards);
    if (options.length === 0) return [];
    return [
      choicePending(ctx.now, {
        playerId: owner,
        kind: 'blade-veteran-exile',
        sourceUid: uid,
        options,
      }),
    ];
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'blade-veteran-exile') {
      return reject('INVALID_CHOICE', '未知的老兵选择');
    }
    const at = ctx.now;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    if (choice === 'pass') return { ok: true, value: [choiceCleared(at)] };
    if (!pending.options.includes(choice)) {
      return reject('INVALID_CHOICE', '不在可选范围');
    }
    const exiled = exileCard(at, state, intent.playerId, choice, ctx.cards);
    const drawn = drawTop(at, exiled.state, intent.playerId, 1);
    return { ok: true, value: [...exiled.events, ...drawn.events, choiceCleared(at)] };
  },
};

/* --------------------------- 炎刃勇士 bladeChampion --------------------------- */

/** 登场时：除外区每 3 张炎刃 → 本回合 +1，最多 +3。 */
export const bladeChampionEffect: EffectModule = {
  onSummon(state, ctx, owner, uid) {
    const p = state.players[owner];
    if (!p) return [];
    const gain = Math.min(3, Math.floor(bladeExileCount(p, ctx.cards) / 3));
    if (gain <= 0) return [];
    return [ev(ctx.now, 'unit:modified', { playerId: owner, uid, tempPower: gain })];
  },
};

/* --------------------------- 炎刃凤凰 bladePhoenix --------------------------- */

/**
 * 登场时：将弃牌区中所有炎刃卡除外；每除外一张本回合 +1（最多 +5）。
 * 逐张除外 → 战旗的「除外时抽牌」自然按每回合一次限流。
 */
export const bladePhoenixEffect: EffectModule = {
  onSummon(state, ctx, owner, uid) {
    const at = ctx.now;
    const e = emitter(state);
    let count = 0;
    for (const gyUid of bladeInGraveyard(state, owner, ctx.cards)) {
      const r = exileCard(at, e.state, owner, gyUid, ctx.cards);
      if (r.events.length === 0) continue;
      e.push(...r.events);
      count += 1;
    }
    if (count > 0) {
      e.push(ev(at, 'unit:modified', { playerId: owner, uid, tempPower: Math.min(5, count) }));
    }
    return e.events;
  },
};
