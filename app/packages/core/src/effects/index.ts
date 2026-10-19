/**
 * 效果注册表与共享助手 —— ADR-0023 §4 / ADR-0025。
 *
 * 与规则注册表同纪律：**新增带效果的卡只加文件与注册行，不改既有文件内部实现**。
 *
 * 卡牌效果的四个挂载点：
 *  - `activate`：玩家主动发动（详情浮层按钮，如统领Ⅰ/Ⅱ、裁决官Ⅰ）；
 *  - `choose`：回答该卡引出的待定选择；
 *  - `onSummon`：登场时（出牌召唤与效果召唤共用）；
 *  - `onPlay`：法术 / 设置法术出牌后结算。
 */

import {
  COMMANDER_SKILL_COST,
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
import { starWatcherEffect } from './star-commander.js';
import {
  starBlessingEffect,
  starChartEffect,
  starFallEffect,
  starGazeEffect,
} from './star-arcana.js';
import {
  starAcolyteEffect,
  starArcherEffect,
  starGiantEffect,
  starGuardEffect,
  starHeraldEffect,
  starLancerEffect,
  starScoutEffect,
  starSovereignEffect,
  starWeaverEffect,
} from './star-troops.js';
import { applyEvents, drawTop, emitter, putRevealedBottom, revealFromDeck } from './primitives.js';

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
  /** 法术 / 设置法术出牌后结算（卡已进入法术区）。 */
  onPlay?(state: GameState, ctx: RuleContext, owner: PlayerId, uid: string): GameEvent[];
  /**
   * **展示时**（docs/17 §2.1 / D-230）：该卡从卡组顶被展示时触发。
   *
   * 与 `onSummon` 的区别：展示的卡**没有进场**，效果只结算「即时收益」
   * （加星轨、直伤、召唤、抽牌、减费）；「本回合此卡力量值 +N」这类
   * 只对已在场的同名卡生效，不在场时由 `card:pending-buff` 暂存到登场。
   */
  onReveal?(state: GameState, ctx: RuleContext, owner: PlayerId, uid: string): GameEvent[];
  /**
   * 指挥官攻击时的可选前置动作（星轨观测者：付 1 费展示）。
   *
   * 由 `commander-attack.ts` 在**结算伤害之前**调用 —— 顺序有意义：
   * 「展示时：本回合指挥官伤害 +1」要能吃到当回合的攻击（docs/17 §6.1）。
   */
  onCommanderAttack?(
    state: GameState,
    intent: Intent,
    ctx: RuleContext,
  ): Result<GameEvent[], Rejection>;
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
  /* 星轨（docs/17） */
  starWatcher: starWatcherEffect,
  starScout: starScoutEffect,
  starAcolyte: starAcolyteEffect,
  starArcher: starArcherEffect,
  starGuard: starGuardEffect,
  starWeaver: starWeaverEffect,
  starLancer: starLancerEffect,
  starHerald: starHeraldEffect,
  starGiant: starGiantEffect,
  starSovereign: starSovereignEffect,
  starChart: starChartEffect,
  starFall: starFallEffect,
  starGaze: starGazeEffect,
  starBlessing: starBlessingEffect,
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
  'star-gaze-pick': starGazeEffect,
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

/**
 * 指挥官技能费用 —— **固定 `COMMANDER_SKILL_COST`（2 费）**。
 *
 * 沿革：卡面原文写【2】；D-228 曾改为「3 − 力量档位」随时间递减；
 * **D-229 撤销了这套通用成长**（各指挥官改用专属资源：炎刃除外区 / 霜律霜痕 / 星轨层数），
 * 于是技能费用回到卡面的固定 2 费。
 */
export function commanderSkillCost(_p: PlayerState): number {
  return COMMANDER_SKILL_COST;
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
 * 排队一条待定选择（H28 / ADR-0031）—— 用于「选择链进行中又需要挂选择」。
 *
 * payload 与 `choice:pending` 同构（都是 `{ choice }`），只是落到 `pendingChoiceQueue`
 * 而不是占用唯一的 `pendingChoice` 槽位；链条结束后由规则层出队重新挂起。
 */
export const choiceQueued = (at: number, choice: PendingChoice): GameEvent =>
  ev(at, 'choice:queued', { choice: choice as unknown as Record<string, unknown> });

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
 * **H28（Era 2026-10-19 拍板，D-145）**：效果召唤同样触发登场效果，包括需要选择的部分。
 * `pendingChoice` 只有一个槽位，而召唤常发生在选择链内部（统领Ⅰ / 号令）——
 * 此时把新选择**入队**（`choice:queued`），等当前链彻底结算完后，由 `effect:choose`
 * 规则层依次出队（`choice:dequeued` + `choice:pending`）重新挂起。
 *
 * 自动部分（磨牌 / 成长 / 全体冻结）不受影响，仍当场结算。
 */
export function summonEntryEvents(
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
  const events = bladeSummonTriggerEvents(at, state, owner, uid, ctx.cards);
  const mod = EFFECTS[inst.defId];
  if (mod?.onSummon) {
    for (const e of mod.onSummon(state, ctx, owner, uid)) {
      // 链中挂选择 → 入队；payload 同构（`{ choice }`），reducer 按 type 分流。
      events.push(state.pendingChoice && e.type === 'choice:pending' ? { ...e, type: 'choice:queued' } : e);
    }
  }
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

/**
 * **展示**（docs/17 §2.1）+ 星轨结算 —— 星轨三处展示入口（指挥官攻击 / 星图 / 凝视星空）
 * 共用，保证「展示 → 星轨 +1 → 触发展示时 → 归位」的次序只有一份实现。
 *
 * 次序：
 *  1. `revealFromDeck`：翻牌、**移入展示区**、公开；
 *  2. 指挥官是星轨观测者 → 每展示 1 张，星轨 +1（Ⅱ 被动）；
 *  3. 星轨环：本回合第一次展示时抽 1 张；
 *  4. 逐张结算「展示时」效果（按翻开顺序）；
 *  5. 结算完毕，把仍在展示区的卡按原顺序送回牌库底。
 *
 * 第 1 步先离场、第 5 步才回底，就是 Era 2026-10-20 的口径「效果执行的时候放在展示区」：
 * 效果期间卡停在展示区，玩家看得见，而抽牌也抽不走它们。
 */
export function starRevealEvents(
  at: number,
  state: GameState,
  owner: PlayerId,
  n: number,
  ctx: RuleContext,
): { events: GameEvent[]; revealed: { uid: string; defId: string }[] } {
  const r = revealFromDeck(at, state, owner, n, ctx, 'star-reveal');
  const e = emitter(r.state);

  const cmd = e.state.players[owner]?.zones.commander[0];
  if (cmd && ctx.cards[cmd.defId]?.defId === 'starWatcher' && r.revealed.length > 0) {
    e.push(ev(at, 'star:mark', { playerId: owner, amount: r.revealed.length }));
  }

  // 星轨环（持续）：每回合**第一次**展示时抽 1 张。
  const p = e.state.players[owner];
  if (p) {
    for (const c of p.zones.spell) {
      if (c.defId !== 'starOrbit') continue;
      const key = `${c.uid}:orbit`;
      if (e.state.players[owner]!.effectsUsed.includes(key)) continue;
      e.push(ev(at, 'effect:used', { playerId: owner, key }));
      e.push(...drawTop(at, e.state, owner, 1).events);
    }
  }

  for (const card of r.revealed) {
    const mod = EFFECTS[card.defId];
    if (!mod?.onReveal) continue;
    e.push(...mod.onReveal(e.state, ctx, owner, card.uid));
  }

  // 结算完才归位：`e.state` 已是全部效果应用后的状态，只把仍在展示区的卡送回牌库底。
  e.push(
    ...putRevealedBottom(
      at,
      e.state,
      owner,
      r.revealed.map((c) => c.uid),
    ),
  );

  return {
    events: [...r.events, ...e.events],
    revealed: r.revealed.map((c) => ({ uid: c.uid, defId: c.defId })),
  };
}

/** 内部用：把事件应用到状态（供效果模块做多步推演）。 */
export { applyEvents };

export { reject, unitPower };
