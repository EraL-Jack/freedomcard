/**
 * 效果注册表与共享助手 —— ADR-0023 §4 / ADR-0025。
 *
 * 与规则注册表同纪律：**新增带效果的卡只加文件与注册行，不改既有文件内部实现**。
 *
 * 卡牌效果的四个挂载点：
 *  - `activate`：玩家主动发动（详情浮层按钮，如统领Ⅰ/Ⅱ、裁决官Ⅰ）；
 *  - `choose`：回答该卡引出的待定选择；
 *  - `onSummon`：登场时（出牌召唤与效果召唤共用）；
 *  - `onPlay`：法术 / 持续法术出牌后结算。
 */

import {
  RULE_ERRORS,
  type CardDef,
  type GameEvent,
  type GameState,
  type Intent,
  type PendingChoice,
  type PlayerId,
  type PlayerState,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';
import { isBladeCard } from '@app/shared/cards';

import { ev, moved, reject, unitPower } from '../ops.js';

import { bladeCremationEffect, bladeTacticsEffect } from './blade-arcana.js';
import { bladeLordEffect } from './blade-lord.js';
import { bladeOrderEffect } from './blade-order.js';
import { bladeTacticianEffect } from './blade-tactician.js';
import {
  bladeChampionEffect,
  bladeGuardEffect,
  bladeKnightEffect,
  bladePhoenixEffect,
  bladeVeteranEffect,
} from './blade-troops.js';
import { frostAdjudicatorEffect } from './frost-commander.js';
import {
  frostColdSnapEffect,
  frostEdictEffect,
  frostFinalJudgmentEffect,
  frostJudgmentEffect,
} from './frost-arcana.js';
import {
  frostApprenticeEffect,
  frostBinderEffect,
  frostJailerEffect,
  frostNightwatchEffect,
  frostWinterbladeEffect,
} from './frost-troops.js';

/** 效果模块接口。 */
export interface EffectModule {
  activate?(
    state: GameState,
    intent: Intent,
    ctx: RuleContext,
    effectId: string,
  ): Result<GameEvent[], Rejection>;
  choose?(
    state: GameState,
    intent: Intent,
    ctx: RuleContext,
    pending: PendingChoice,
  ): Result<GameEvent[], Rejection>;
  /** 登场时（含效果召唤）。返回的事件可含 `choice:pending`。 */
  onSummon?(state: GameState, ctx: RuleContext, owner: PlayerId, uid: string): GameEvent[];
  /** 法术 / 持续法术出牌后结算（卡已进入法术区）。 */
  onPlay?(state: GameState, ctx: RuleContext, owner: PlayerId, uid: string): GameEvent[];
}

/** 按卡定义派发。 */
export const EFFECTS: Readonly<Record<string, EffectModule>> = {
  bladeLord: bladeLordEffect,
  bladeOrder: bladeOrderEffect,
  bladeTactician: bladeTacticianEffect,
  bladeGuard: bladeGuardEffect,
  bladeKnight: bladeKnightEffect,
  bladeVeteran: bladeVeteranEffect,
  bladeChampion: bladeChampionEffect,
  bladePhoenix: bladePhoenixEffect,
  bladeTactics: bladeTacticsEffect,
  bladeCremation: bladeCremationEffect,
  frostAdjudicator: frostAdjudicatorEffect,
  frostApprentice: frostApprenticeEffect,
  frostBinder: frostBinderEffect,
  frostNightwatch: frostNightwatchEffect,
  frostJailer: frostJailerEffect,
  frostWinterblade: frostWinterbladeEffect,
  frostEdict: frostEdictEffect,
  frostColdSnap: frostColdSnapEffect,
  frostJudgment: frostJudgmentEffect,
  frostFinalJudgment: frostFinalJudgmentEffect,
};

/** 按待定选择种类反查模块（choose 阶段只有 kind 可查）。 */
export const EFFECTS_BY_KIND: Readonly<Record<string, EffectModule>> = {
  'blade-lord-1': bladeLordEffect,
  'blade-lord-1-target': bladeLordEffect,
  'blade-lord-2': bladeLordEffect,
  'blade-scout-exile': bladeOrderEffect,
  'blade-order-summon': bladeOrderEffect,
  'blade-guard-exile': bladeGuardEffect,
  'blade-knight-attack': bladeKnightEffect,
  'blade-veteran-exile': bladeVeteranEffect,
  'blade-tactics-target': bladeTacticsEffect,
  'blade-cremation': bladeCremationEffect,
  'frost-adjudicator-1': frostAdjudicatorEffect,
  'frost-apprentice-freeze': frostApprenticeEffect,
  'frost-binder-freeze': frostBinderEffect,
  'frost-nightwatch-freeze': frostNightwatchEffect,
  'frost-edict-freeze': frostEdictEffect,
  'frost-coldsnap-freeze': frostColdSnapEffect,
  'frost-judgment-target': frostJudgmentEffect,
};

/* ------------------------------ 共享助手 ------------------------------ */

/** 除外区里「卡名包含炎刃」的卡数量 —— 统领档位与军师次数的共同计数口径（卡面原文）。 */
export function bladeExileCount(p: PlayerState, cards: Record<string, CardDef>): number {
  return p.zones.exile.filter((c) => {
    const def = cards[c.defId];
    return def !== undefined && isBladeCard(def);
  }).length;
}

/** 「每回合一次」记帐键（ADR-0023 §3）。 */
export function effectKey(uid: string, effectId: string): string {
  return `${uid}:${effectId}`;
}

/** 已用过则拒绝。 */
export function usedGuard(p: PlayerState, uid: string, effectId: string): Rejection | null {
  return p.effectsUsed.includes(effectKey(uid, effectId))
    ? { code: RULE_ERRORS.EFFECT_UNAVAILABLE, message: '该效果每回合只能发动一次' }
    : null;
}

/**
 * 从费用区支付 `count` 张（统领【2】/ 裁决官【2】= 费用区 2 张，Era 2026-10-18 口径）。
 *
 * docs/16 §3.3：`maxCost` 是「本回合所有支付的总张数上限」，效果支付同样受它约束，
 * 并计入 `usedCostThisTurn`（`cost:spent`）—— 与出牌走同一记帐，否则
 * 「先出 3 费再付 2 费效果」会突破第 2 回合的 3 费上限。
 */
export function payCostCards(
  at: number,
  playerId: PlayerId,
  p: PlayerState,
  count: number,
): GameEvent[] | Rejection {
  if (p.zones.cost.length < count) {
    return {
      code: RULE_ERRORS.INSUFFICIENT_COST,
      message: `费用不足：需要 ${count} 张，费用区仅有 ${p.zones.cost.length} 张`,
    };
  }
  if (count > 0 && p.usedCostThisTurn + count > p.maxCost) {
    return {
      code: RULE_ERRORS.MAX_COST_EXCEEDED,
      message: `本回合费用上限 ${p.maxCost} 张，已用 ${p.usedCostThisTurn} 张`,
    };
  }
  const moves = p.zones.cost.slice(0, count).map((c) => moved(at, playerId, c.uid, 'cost', 'graveyard'));
  if (count === 0) return moves;
  return [...moves, ev(at, 'cost:spent', { playerId, amount: count })];
}

/** 待定选择事件（进状态必须走事件，ADR-0023 §2）。 */
export const choicePending = (at: number, choice: PendingChoice): GameEvent =>
  ev(at, 'choice:pending', { choice: choice as unknown as Record<string, unknown> });

export const choiceCleared = (at: number): GameEvent => ev(at, 'choice:cleared');

/**
 * 登场触发器（军师 / 队长，ADR-0023 §7 + docs/12 §2.4）：
 *  - 军师：己方炎刃随从登场 → 该随从 tempPower+1（次数 = 发动时除外区炎刃数）；
 *  - 队长：**其他**炎刃随从登场 → 该随从 tempPower+1（每个队长各 +1）。
 * 出牌（play.ts）与效果召唤（统领 1 档 / 号令）共用。
 */
export function bladeSummonTriggerEvents(
  at: number,
  state: GameState,
  owner: PlayerId,
  summonedUid: string,
  cards: Record<string, CardDef>,
): GameEvent[] {
  const p = state.players[owner];
  if (!p) return [];
  // 按 uid 全场找定义（召唤事件可能还没 reduce 进状态，调用方传的可能是推演后状态）。
  const inst = Object.values(state.players)
    .flatMap((x) => Object.values(x.zones).flat())
    .find((c) => c.uid === summonedUid);
  const def = inst ? cards[inst.defId] : undefined;
  if (!def || def.type !== 'minion' || !isBladeCard(def)) return [];

  const events: GameEvent[] = [];
  for (const t of p.turnTriggers) {
    if (t.kind !== 'on-blade-summon' || t.remaining <= 0) continue;
    events.push(ev(at, 'unit:modified', { playerId: owner, uid: summonedUid, tempPower: 1 }));
    events.push(ev(at, 'trigger:spent', { playerId: owner, sourceUid: t.sourceUid }));
  }
  // 队长：「其他」炎刃随从登场 —— 排除刚登场的自己。
  for (const c of p.zones.board) {
    if (c.uid === summonedUid) continue;
    if (cards[c.defId]?.defId !== 'bladeCaptain') continue;
    events.push(ev(at, 'unit:modified', { playerId: owner, uid: summonedUid, tempPower: 1 }));
  }
  return events;
}

/**
 * 登场效果派发（由 play.ts / 效果召唤调用）。
 *
 * `allowChoice: false` 用于**已在某个待定选择链中**的召唤（如统领 1 档）：
 * `pendingChoice` 只有一个槽位，嵌套会产生「后一个覆盖前一个」。
 * 此时只结算自动部分（磨牌 / 成长 / 全体冻结），跳过需要选择的部分 ——
 * 这是当前架构的已知取舍，登记在 ADR-0025「实现边界」。
 */
export function summonEntryEvents(
  at: number,
  state: GameState,
  owner: PlayerId,
  uid: string,
  ctx: RuleContext,
  opts: { allowChoice?: boolean } = {},
): GameEvent[] {
  const inst = Object.values(state.players)
    .flatMap((x) => Object.values(x.zones).flat())
    .find((c) => c.uid === uid);
  if (!inst) return [];
  const events = bladeSummonTriggerEvents(at, state, owner, uid, ctx.cards);
  const mod = EFFECTS[inst.defId];
  if (mod?.onSummon) events.push(...mod.onSummon(state, ctx, owner, uid));
  if (opts.allowChoice === false) return events.filter((e) => e.type !== 'choice:pending');
  return events;
}

/** 法术出牌结算派发。 */
export function spellEntryEvents(
  at: number,
  state: GameState,
  owner: PlayerId,
  uid: string,
  ctx: RuleContext,
): GameEvent[] {
  const inst = Object.values(state.players)
    .flatMap((x) => Object.values(x.zones).flat())
    .find((c) => c.uid === uid);
  if (!inst) return [];
  const mod = EFFECTS[inst.defId];
  return mod?.onPlay ? mod.onPlay(state, ctx, owner, uid) : [];
}

export { reject, unitPower };
