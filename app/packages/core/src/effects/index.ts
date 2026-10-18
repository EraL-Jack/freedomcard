/**
 * 效果注册表与共享助手 —— ADR-0023 §4：一卡一文件，按 `defId` 派发。
 *
 * 与规则注册表同纪律：**新增带效果的卡只加文件与注册行，不改既有文件内部实现**。
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

import { bladeLordEffect } from './blade-lord.js';
import { bladeOrderEffect } from './blade-order.js';
import { bladeTacticianEffect } from './blade-tactician.js';

/** 效果模块接口：发动 + （可选）回答该卡引出的待定选择。 */
export interface EffectModule {
  activate(
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
}

/** 按卡定义派发。 */
export const EFFECTS: Readonly<Record<string, EffectModule>> = {
  bladeLord: bladeLordEffect,
  bladeOrder: bladeOrderEffect,
  bladeTactician: bladeTacticianEffect,
};

/** 按待定选择种类反查模块（choose 阶段只有 kind 可查）。 */
export const EFFECTS_BY_KIND: Readonly<Record<string, EffectModule>> = {
  'blade-lord-1': bladeLordEffect,
  'blade-lord-1-target': bladeLordEffect,
  'blade-lord-2': bladeLordEffect,
  'blade-scout-exile': bladeOrderEffect,
  'blade-order-summon': bladeOrderEffect,
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

/** 从费用区支付 `count` 张（统领【2】= 费用区 2 张，Era 2026-10-18 口径）。 */
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
  return p.zones.cost.slice(0, count).map((c) => moved(at, playerId, c.uid, 'cost', 'graveyard'));
}

/** 待定选择事件（进状态必须走事件，ADR-0023 §2）。 */
export const choicePending = (at: number, choice: PendingChoice): GameEvent =>
  ev(at, 'choice:pending', { choice: choice as unknown as Record<string, unknown> });

export const choiceCleared = (at: number): GameEvent => ev(at, 'choice:cleared');

/**
 * 炎刃随从登场触发器（军师，ADR-0023 §7）：
 * 登场的是己方炎刃随从且触发器有剩余次数 → tempPower+1 并消耗一次。
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
  // 按 uid 全场找定义（召唤事件可能还没 reduce 进状态，调用方可能传的是推演后状态，
  // 也可能传原状态 + 卡还在墓地/卡组 —— 这里只要 defId，不挑区域）。
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
  return events;
}

export { reject, unitPower };
