/**
 * 星轨法术（docs/17 §5.3 / D-230）。
 *
 * 四张法术全部围绕「展示」：星图补一次展示、凝视星空展示 2 张并选 1 张进手牌；
 * 星陨与星赐是纯数值牌（直伤 / 群体力量值），不参与展示链。
 *
 * 星轨环是设置法术，效果挂在 `starRevealEvents`（每回合第一次展示抽 1），
 * 这里没有 `onPlay`。
 */

import {
  RULE_ERRORS,
  type GameEvent,
  type PendingChoice,
  type Result,
  type Rejection,
} from '@app/shared';

import { commanderDamageEvents } from '../combat.js';
import { ev, moved, reject, strArg } from '../ops.js';
import { opponentOf } from '../state.js';

import {
  choiceCleared,
  choicePending,
  starRevealEvents,
  type EffectModule,
} from './index.js';
import { applyEvents } from './primitives.js';

/** 星图：展示卡组顶 1 张，触发展示时，置牌库底。 */
export const starChartEffect: EffectModule = {
  onPlay: (state, ctx, owner) => starRevealEvents(ctx.now, state, owner, 1, ctx).events,
};

/** 星陨：对敌方指挥官造成 2 点伤害（固定，不再随展示张数变化）。 */
export const starFallEffect: EffectModule = {
  onPlay: (state, ctx, owner, uid) => {
    const foe = opponentOf(state, owner);
    if (!foe) return [];
    return commanderDamageEvents(ctx.now, state, foe, 2, uid, owner);
  },
};

/**
 * 凝视星空：展示 2 张 → 选 1 张加入手牌，其余按原顺序置入牌库底。
 *
 * 展示时先把整批送进展示区、结算完再送回牌库底（`revealFromDeck` + `putRevealedBottom`），
 * 选择阶段再把选中的那张从牌库移到手牌 —— 「其余置底」天然已经满足，不需要额外事件。
 */
export const starGazeEffect: EffectModule = {
  onPlay: (state, ctx, owner) => {
    const at = ctx.now;
    const r = starRevealEvents(at, state, owner, 2, ctx);
    // 只在「仍在卡组」的展示卡里选（展示触发可能已经把它抽走 / 召唤走）。
    const after = applyEvents(state, r.events);
    const deckUids = new Set(after.players[owner]?.zones.deck.map((c) => c.uid) ?? []);
    const options = r.revealed.map((c) => c.uid).filter((uid) => deckUids.has(uid));
    if (options.length === 0) return r.events;
    return [
      ...r.events,
      choicePending(at, {
        playerId: owner,
        kind: 'star-gaze-pick',
        sourceUid: '',
        options,
      }),
    ];
  },

  choose(state, intent, ctx, pending: PendingChoice): Result<GameEvent[], Rejection> {
    if (pending.kind !== 'star-gaze-pick') {
      return reject(RULE_ERRORS.INVALID_CHOICE, '未知的凝视星空选择');
    }
    const at = ctx.now;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    if (choice === 'pass') return { ok: true, value: [choiceCleared(at)] };
    if (!pending.options.includes(choice)) {
      return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
    }
    const loc = state.players[intent.playerId]?.zones.deck.find((c) => c.uid === choice);
    if (!loc) return reject(RULE_ERRORS.CARD_NOT_IN_ZONE, '该卡已不在牌库');
    return {
      ok: true,
      value: [moved(at, intent.playerId, choice, 'deck', 'hand'), choiceCleared(at)],
    };
  },
};

/** 星赐：本回合所有己方随从力量值 +1。 */
export const starBlessingEffect: EffectModule = {
  onPlay: (state, ctx, owner) => {
    const p = state.players[owner];
    if (!p) return [];
    return p.zones.board.map((c) =>
      ev(ctx.now, 'unit:modified', { playerId: owner, uid: c.uid, tempPower: 1 }),
    );
  },
};
