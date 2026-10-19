/**
 * 炎刃法术 —— docs/12 §2.3（ADR-0025）。
 *
 * - 炎刃战术 `bladeTactics`：选择一个己方随从，本回合 +2（除外区炎刃 ≥ 3 时 +3）。
 * - 炎刃焚典 `bladeCremation`：展示卡组顶 4 张，任意数量炎刃卡除外，其余进弃牌区。
 *
 * 战旗 `bladeBanner` 没有模块：它的「除外时抽 1」挂在 `primitives.exileCard`，
 * 保证**所有**除外路径都触发（骑士 / 老兵 / 凤凰 / 焚典 / 统领Ⅱ）。
 */

import {
  type GameEvent,
  type GameState,
  type PlayerId,
} from '@app/shared';
import { isBladeCard } from '@app/shared/cards';

import { ev, moved, reject, strArg } from '../ops.js';

import { bladeExileCount, choiceCleared, choicePending, type EffectModule } from './index.js';
import { exileCard } from './primitives.js';

/* --------------------------- 炎刃战术 bladeTactics --------------------------- */

export const bladeTacticsEffect: EffectModule = {
  onPlay(state, ctx, owner, uid) {
    const p = state.players[owner];
    if (!p || p.zones.board.length === 0) return [];
    return [
      choicePending(ctx.now, {
        playerId: owner,
        kind: 'blade-tactics-target',
        sourceUid: uid,
        options: p.zones.board.map((c) => c.uid),
      }),
    ];
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'blade-tactics-target') {
      return reject('INVALID_CHOICE', '未知的战术选择');
    }
    const at = ctx.now;
    const me = intent.playerId;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    if (!pending.options.includes(choice)) {
      return reject('INVALID_CHOICE', '请选择一个己方随从');
    }
    const p = state.players[me];
    const gain = p && bladeExileCount(p, ctx.cards) >= 3 ? 3 : 2;
    return {
      ok: true,
      value: [
        ev(at, 'unit:modified', { playerId: me, uid: choice, tempPower: gain }),
        choiceCleared(at),
      ],
    };
  },
};

/* --------------------------- 炎刃焚典 bladeCremation --------------------------- */

/** 展示张数（卡面原文「卡组顶4张」）。 */
const CREMATION_REVEAL = 4;

function revealedUids(pending: { meta?: Record<string, unknown> }): string[] {
  const v = pending.meta?.['left'];
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
}

/** 把 `left` 里仍在卡组的卡全部置入弃牌区（「其余置入弃牌区」）。 */
function millRemaining(
  at: number,
  state: GameState,
  playerId: PlayerId,
  left: string[],
): GameEvent[] {
  const events: GameEvent[] = [];
  const p = state.players[playerId];
  if (!p) return events;
  for (const uid of left) {
    if (!p.zones.deck.some((c) => c.uid === uid)) continue;
    events.push(moved(at, playerId, uid, 'deck', 'graveyard'));
  }
  return events;
}

export const bladeCremationEffect: EffectModule = {
  onPlay(state, ctx, owner, uid) {
    const p = state.players[owner];
    if (!p) return [];
    const at = ctx.now;
    const top = p.zones.deck.slice(0, CREMATION_REVEAL);
    const events: GameEvent[] = top.map((c) =>
      ev(at, 'card:revealed', { playerId: owner, uid: c.uid, from: 'deck', reason: 'blade-cremation' }),
    );
    if (top.length === 0) return events;

    const left = top.map((c) => c.uid);
    const bladeLeft = top.filter((c) => {
      const def = ctx.cards[c.defId];
      return def !== undefined && isBladeCard(def);
    });
    if (bladeLeft.length === 0) {
      // 没有可除外的炎刃卡 → 全部进弃牌区，不弹空选择
      events.push(...top.map((c) => moved(at, owner, c.uid, 'deck', 'graveyard')));
      return events;
    }
    events.push(
      choicePending(at, {
        playerId: owner,
        kind: 'blade-cremation',
        sourceUid: uid,
        options: bladeLeft.map((c) => c.uid),
        meta: { left },
      }),
    );
    return events;
  },

  choose(state, intent, ctx, pending) {
    if (pending.kind !== 'blade-cremation') {
      return reject('INVALID_CHOICE', '未知的焚典选择');
    }
    const at = ctx.now;
    const me = intent.playerId;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    const left = revealedUids(pending);

    // 结束选择：其余全部进弃牌区
    if (choice === 'pass') {
      const events = millRemaining(at, state, me, left);
      return { ok: true, value: [...events, choiceCleared(at)] };
    }
    if (!pending.options.includes(choice)) {
      return reject('INVALID_CHOICE', '只能选择展示中的炎刃卡');
    }

    const exiled = exileCard(at, state, me, choice, ctx.cards);
    const rest = left.filter((u) => u !== choice);
    const nextState = exiled.state;
    const bladeRest = rest.filter((u) => {
      const p = nextState.players[me];
      const card = p?.zones.deck.find((c) => c.uid === u);
      const def = card ? ctx.cards[card.defId] : undefined;
      return def !== undefined && isBladeCard(def);
    });

    const events = [...exiled.events];
    if (bladeRest.length > 0) {
      events.push(
        choicePending(at, {
          playerId: me,
          kind: 'blade-cremation',
          sourceUid: pending.sourceUid,
          options: bladeRest,
          meta: { left: rest },
        }),
      );
    } else {
      events.push(...millRemaining(at, nextState, me, rest));
      events.push(choiceCleared(at));
    }
    return { ok: true, value: events };
  },
};
