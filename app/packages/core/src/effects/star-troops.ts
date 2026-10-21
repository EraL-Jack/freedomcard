/**
 * 星轨随从的「展示时」效果（docs/17 §5 / D-230）。
 *
 * 这些卡大多**没被打出**，只是从卡组顶被翻出来 —— 所以效果只结算即时收益：
 * 加星轨、直伤、抽牌、召唤、减费；「本回合此卡力量值 +N」对不在场的卡
 * 记为「本回合它登场时获得 +N」（`card:pending-buff`，docs/17 §6.3 方案 A）。
 */

import type { GameEvent, GameState, PlayerId } from '@app/shared/types';

import { commanderDamageEvents } from '../combat.js';
import { ev, locate } from '../ops.js';
import { opponentOf } from '../state.js';

import { drawTop, summonToken } from './primitives.js';
import type { EffectModule } from './index.js';/** 该实例此刻在不在随从区（决定 +N 力量是立刻生效还是暂存到登场）。 */
function onBoard(state: GameState, uid: string): boolean {
  return locate(state, uid)?.zone === 'board';
}

/** 「每回合最多触发一次」的通用守卫键（记在 `effectsUsed`，回合切换清零）。 */
function usedThisTurn(state: GameState, owner: PlayerId, key: string): boolean {
  return state.players[owner]?.effectsUsed.includes(key) ?? false;
}

const markUsed = (at: number, owner: PlayerId, key: string): GameEvent =>
  ev(at, 'effect:used', { playerId: owner, key });

/** 星轨斥候：展示时，获得 1 层星轨。 */
export const starScoutEffect: EffectModule = {
  onReveal: (_state, ctx, owner) => [ev(ctx.now, 'star:mark', { playerId: owner, amount: 1 })],
};

/** 星轨侍僧：展示时，本回合指挥官伤害值 +1（不可叠加）。 */
export const starAcolyteEffect: EffectModule = {
  onReveal: (state, ctx, owner) => {
    if (usedThisTurn(state, owner, 'star:acolyte')) return [];
    return [
      markUsed(ctx.now, owner, 'star:acolyte'),
      ev(ctx.now, 'commander:damage-bonus', { playerId: owner, amount: 1 }),
    ];
  },
};

/** 星轨弓手：展示时，对敌方指挥官造成 1 点伤害（每回合最多触发 1 次）。 */
export const starArcherEffect: EffectModule = {
  onReveal: (state, ctx, owner, uid) => {
    const foe = opponentOf(state, owner);
    if (!foe) return [];
    if (usedThisTurn(state, owner, 'star:archer')) return [];
    return [
      markUsed(ctx.now, owner, 'star:archer'),
      ...commanderDamageEvents(ctx.now, state, foe, 1, uid, owner, ctx),
    ];
  },
};

/** 星轨守卫：展示时，抽 1 张。 */
export const starGuardEffect: EffectModule = {
  onReveal: (state, ctx, owner) => drawTop(ctx.now, state, owner, 1).events,
};

/** 星轨织者：展示时，召唤 1 个星灵（力量值1 / 伤害值1）。 */
export const starWeaverEffect: EffectModule = {
  onReveal: (state, ctx, owner) => summonToken(ctx.now, state, owner, 'starSpirit1', ctx),
};

/** 星轨枪手：展示时，本回合此卡力量值 +2（不在场则暂存到登场）。 */
export const starLancerEffect: EffectModule = {
  onReveal: (state, ctx, owner, uid) =>
    onBoard(state, uid)
      ? [ev(ctx.now, 'unit:modified', { playerId: owner, uid, tempPower: 2 })]
      : [ev(ctx.now, 'card:pending-buff', { playerId: owner, uid, amount: 2 })],
};

/** 星轨传令：展示时，本回合打出的下一张随从费用 -1。 */
export const starHeraldEffect: EffectModule = {
  onReveal: (_state, ctx, owner) => [ev(ctx.now, 'cost:discount', { playerId: owner, amount: 1 })],
};

/** 星轨巨像：展示时，本回合此卡力量值 +1。 */
export const starGiantEffect: EffectModule = {
  onReveal: (state, ctx, owner, uid) =>
    onBoard(state, uid)
      ? [ev(ctx.now, 'unit:modified', { playerId: owner, uid, tempPower: 1 })]
      : [ev(ctx.now, 'card:pending-buff', { playerId: owner, uid, amount: 1 })],
};

/** 星轨君王：展示时，召唤 1 个星灵（力量值3 / 伤害值3）。 */
export const starSovereignEffect: EffectModule = {
  onReveal: (state, ctx, owner) => summonToken(ctx.now, state, owner, 'starSpirit3', ctx),
};
