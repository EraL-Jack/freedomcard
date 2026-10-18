/**
 * 炎刃号令（bladeOrder，法术）— ADR-0023 §6；斥候（bladeScout）的展示触发也在此结算（§8）。
 *
 * 卡面原文：展示卡组顶7张卡，选择其中一个力量值在你除外区的炎刃数量以下的随从召唤。
 *
 * 流程：
 *  1. 出牌结算（play.ts 接线）：支付 + 进法术区后，展示卡组顶 7 张（`card:revealed`，不动卡）；
 *  2. 若展示中有斥候 → 先问「是否除外斥候」（斥候卡面：从卡组展示时可以被除外）；
 *  3. 再从展示中选择力量值 ≤ 除外区炎刃数的随从召唤（随从区满则无可选）；
 *  4. 未选中的洗回卡组（H21，卡面未说去处，取通行做法；`rng:advance` + `deck:shuffled`）。
 */

import {
  BOARD_SLOTS,
  RULE_ERRORS,
  type CardInstance,
  type GameEvent,
  type GameState,
  type PendingChoice,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import { ev, moved, reject, rngAdvance, deckShuffled, strArg } from '../ops.js';
import { reduce } from '../reducer.js';
import { shuffle } from '../rng.js';

import {
  bladeExileCount,
  bladeSummonTriggerEvents,
  choiceCleared,
  choicePending,
  type EffectModule,
} from './index.js';

/** 号令展示的张数（卡面原文「卡组顶7张」）。 */
export const ORDER_REVEAL_COUNT = 7;

function revealUids(pending: PendingChoice): string[] {
  const v = pending.meta?.['revealed'];
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
}

/**
 * 号令的**出牌后结算**（由 play.ts 在支付与入区之后调用）。
 * 只产出「展示 + 待定选择」事件；真正的召唤/洗回发生在 choose 阶段。
 */
export function bladeOrderResolution(
  at: number,
  state: GameState,
  ctx: RuleContext,
  playerId: string,
  sourceUid: string,
): GameEvent[] {
  const p = state.players[playerId];
  if (!p) return [];
  const revealed = p.zones.deck.slice(0, ORDER_REVEAL_COUNT);
  const events: GameEvent[] = revealed.map((c) =>
    ev(at, 'card:revealed', { playerId, uid: c.uid, from: 'deck', reason: 'blade-order' }),
  );
  if (revealed.length === 0) return events;

  const scouts = revealed.filter((c) => c.defId === 'bladeScout');
  if (scouts.length > 0) {
    // 斥候的展示触发先于召唤选择（卡面：展示时可以被除外）
    events.push(
      choicePending(at, {
        playerId,
        kind: 'blade-scout-exile',
        sourceUid,
        options: scouts.map((c) => c.uid),
        meta: { revealed: revealed.map((c) => c.uid) },
      }),
    );
    return events;
  }
  events.push(summonChoice(at, state, ctx, playerId, sourceUid, revealed.map((c) => c.uid)));
  return events;
}

/** 召唤选择（随从区满或无人选时 options 为空，只能 pass → 洗回）。 */
function summonChoice(
  at: number,
  state: GameState,
  ctx: RuleContext,
  playerId: string,
  sourceUid: string,
  revealed: string[],
): GameEvent {
  const p = state.players[playerId];
  if (!p) return choiceCleared(at);
  const bladeCount = bladeExileCount(p, ctx.cards);
  const hasSpace = p.zones.board.length < BOARD_SLOTS;
  const candidates = hasSpace
    ? revealed.filter((uid) => {
        const c = p.zones.deck.find((x) => x.uid === uid);
        const def = c ? ctx.cards[c.defId] : undefined;
        return def?.type === 'minion' && def.power <= bladeCount;
      })
    : [];
  return choicePending(at, {
    playerId,
    kind: 'blade-order-summon',
    sourceUid,
    options: candidates,
    meta: { revealed },
  });
}

/** 收尾：把仍留在卡组里的展示卡洗回去（H21），并清掉待定选择。 */
function shuffleBackEvents(
  at: number,
  state: GameState,
  playerId: string,
  revealed: string[],
  takenOut: string[],
): GameEvent[] {
  const p = state.players[playerId];
  if (!p) return [choiceCleared(at)];
  // 推演到当前事件已应用的 deck —— 调用方应传入**应用了召唤/除外事件后**的状态；
  // 但规则内部不先 reduce（事件由引擎统一落地），故手工剔除已离卡组的卡。
  const deckNow: CardInstance[] = p.zones.deck.filter((c) => !takenOut.includes(c.uid));
  const toShuffle = revealed.filter((uid) => !takenOut.includes(uid));
  if (toShuffle.length === 0) return [choiceCleared(at)];
  const s = shuffle(state.rngCursor, deckNow);
  return [
    rngAdvance(at, Math.max(0, deckNow.length - 1)),
    deckShuffled(at, playerId, s.items.map((c) => c.uid)),
    choiceCleared(at),
  ];
}

export const bladeOrderEffect: EffectModule = {
  activate(_state, _intent, _ctx, effectId): Result<GameEvent[], Rejection> {
    // 号令是法术，出牌即结算，没有「在场发动」的效果
    return reject(RULE_ERRORS.EFFECT_UNAVAILABLE, `未知效果: ${effectId}`);
  },

  choose(state, intent, ctx, pending): Result<GameEvent[], Rejection> {
    const at = ctx.now;
    const choice = strArg(intent.payload?.['choice']) ?? '';
    const me = intent.playerId;
    const revealed = revealUids(pending);

    // 斥候：除外或跳过，然后进入召唤选择
    if (pending.kind === 'blade-scout-exile') {
      if (choice !== 'pass' && !pending.options.includes(choice)) {
        return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
      }
      const events: GameEvent[] = [];
      const takenOut: string[] = [];
      if (choice !== 'pass') {
        events.push(moved(at, me, choice, 'deck', 'exile'));
        takenOut.push(choice);
        // 斥候后半句「本应置入伤害区则补一张」：号令的展示**不**置入伤害区，分支不触发（ADR-0023 §8）
      }
      // 展示中的其余卡继续走召唤选择；meta.revealed 剔除已除外的
      const rest = revealed.filter((uid) => !takenOut.includes(uid));
      // 注意：此处需要**应用过除外事件后**的状态来判定候选 —— 手工推演一次
      const next = events.reduce(reduce, state);
      events.push(summonChoice(at, next, ctx, me, pending.sourceUid, rest));
      return { ok: true, value: events };
    }

    // 召唤：选一个随从召唤，其余洗回
    if (choice !== 'pass' && !pending.options.includes(choice)) {
      return reject(RULE_ERRORS.INVALID_CHOICE, '不在可选范围');
    }
    const events: GameEvent[] = [];
    const takenOut: string[] = [];
    if (choice !== 'pass') {
      events.push(moved(at, me, choice, 'deck', 'board'));
      takenOut.push(choice);
      // 登场触发器（军师）：号令召唤的炎刃随从同样触发（ADR-0023 §7）
      events.push(...bladeSummonTriggerEvents(at, state, me, choice, ctx.cards));
    }
    // 洗回要在召唤事件**之后**的牌序上算 —— 先推演再算新序
    const next = events.reduce(reduce, state);
    events.push(...shuffleBackEvents(at, next, me, revealed, takenOut));
    return { ok: true, value: events };
  },
};

