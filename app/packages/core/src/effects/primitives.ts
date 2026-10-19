/**
 * 效果原语 —— 被多张卡共用的**结算片段**（ADR-0025 §3）。
 *
 * 为什么单独成文件：霜冻、除外、抽牌、指挥官直伤这四件事在 10+ 张卡里重复出现，
 * 各写一份会让「被霜冻时触发」「除外时抽牌」这类全局限定散落各处，
 * 出现「某张卡的除外不触发战旗」这种难查的漏接线。
 *
 * 纪律：全部纯函数（`at` / `ctx.now` 由调用方传入），返回事件并同时给出推演后的状态，
 * 供同一张卡的后续步骤继续使用。
 */

import {
  BOARD_SLOTS,
  type CardDef,
  type CardInstance,
  type GameEvent,
  type GameState,
  type PlayerId,
  type RuleContext,
} from '@app/shared';
import { isBladeCard } from '@app/shared/cards';

import { drawCards, ev, locate, moved, takeFromDeck } from '../ops.js';
import { reduce } from '../reducer.js';
import { shuffle } from '../rng.js';

/** 把一批事件就地应用到状态（效果内部推演用）。 */
export function applyEvents(state: GameState, events: readonly GameEvent[]): GameState {
  let s = state;
  for (const e of events) s = reduce(s, e);
  return s;
}

/** 事件收集器：push 的同时把状态推进一步，保证后续步骤读到的是已结算状态。 */
export interface Emitter {
  events: GameEvent[];
  push: (...events: GameEvent[]) => void;
  readonly state: GameState;
}

export function emitter(state: GameState): Emitter {
  const events: GameEvent[] = [];
  let s = state;
  return {
    events,
    push: (...es: GameEvent[]) => {
      for (const e of es) {
        events.push(e);
        s = reduce(s, e);
      }
    },
    get state() {
      return s;
    },
  };
}

/* ------------------------------ 抽牌 / 磨牌 ------------------------------ */

/** 抽 `n` 张（卡组用尽时按 A9 补充 2 洗回弃牌区），返回事件与推演后状态。 */
export function drawTop(
  at: number,
  state: GameState,
  playerId: PlayerId,
  n = 1,
): { events: GameEvent[]; state: GameState } {
  const p = state.players[playerId];
  if (!p || n <= 0) return { events: [], state };
  const d = drawCards(
    at,
    playerId,
    { deck: p.zones.deck, graveyard: p.zones.graveyard },
    n,
    state.rngCursor,
  );
  return { events: d.events, state: applyEvents(state, d.events) };
}

/** 从卡组顶把 `n` 张置入指定区域（磨牌 / 收入），可选先展示。 */
export function millTop(
  at: number,
  state: GameState,
  playerId: PlayerId,
  n: number,
  to: 'graveyard' | 'cost',
  reveal = false,
): { events: GameEvent[]; taken: CardInstance[]; state: GameState } {
  const p = state.players[playerId];
  if (!p || n <= 0) return { events: [], taken: [], state };
  const d = takeFromDeck(
    at,
    playerId,
    { deck: p.zones.deck, graveyard: p.zones.graveyard },
    n,
    state.rngCursor,
    to,
    reveal,
  );
  return { events: d.events, taken: d.taken, state: applyEvents(state, d.events) };
}

/* ------------------------------ 展示 ------------------------------ */

export interface RevealResult {
  events: GameEvent[];
  /** 被展示的卡（按翻开顺序）。调用方据此做后续选择（如「凝视星空」选 1 张进手牌）。 */
  revealed: CardInstance[];
  state: GameState;
}

/**
 * **展示**（docs/17 §2.1 / D-230）：从卡组顶依次翻开 `n` 张，公开给双方，
 * 结算完毕按原顺序置入**牌库底**。
 *
 * 与抽牌的区别：不进手牌、不烧牌库、触发「展示时」效果。
 *
 * ⚠️ **置底早于触发**（实现口径，登记假设 H35）：若等触发结算完再置底，
 * 触发里的抽牌会把「已展示但还没归位」的卡抽走，与「展示后回牌库底」矛盾。
 * 故先把这批卡挪到牌库底，再逐张结算「展示时」—— 触发读到的是卡定义，
 * 不依赖它在牌堆里的位置。
 *
 * 牌库不足时把墓地洗回（沿用 A9 补充 2 的 reshuffle，与抽牌同一口径）。
 */
export function revealFromDeck(
  at: number,
  state: GameState,
  playerId: PlayerId,
  n: number,
  ctx: RuleContext,
  reason = 'reveal',
): RevealResult {
  const p = state.players[playerId];
  if (!p || n <= 0) return { events: [], revealed: [], state };
  const e = emitter(state);

  // 牌库不足 → 墓地洗回。显式用 `card:moved` 把墓地卡搬回牌库，再整体重排：
  // `deck:shuffled` 只会重排「已在卡组里的卡」，不会替我们搬区域。
  if (e.state.players[playerId]!.zones.deck.length < n) {
    const gy = e.state.players[playerId]!.zones.graveyard;
    if (gy.length > 0) {
      for (const c of gy) e.push(moved(at, playerId, c.uid, 'graveyard', 'deck'));
      const deckNow = e.state.players[playerId]!.zones.deck;
      const s = shuffle(e.state.rngCursor, deckNow);
      e.push(ev(at, 'rng:advance', { steps: Math.max(0, deckNow.length - 1) }));
      e.push(ev(at, 'deck:shuffled', { playerId, order: s.items.map((c) => c.uid) }));
    }
  }

  const deck = e.state.players[playerId]!.zones.deck;
  const top = deck.slice(0, Math.min(n, deck.length));
  if (top.length === 0) return { events: e.events, revealed: [], state: e.state };

  for (const c of top) {
    e.push(ev(at, 'card:revealed', { playerId, uid: c.uid, from: 'deck', reason }));
  }
  // 按原顺序置底（docs/17 §2.1）
  e.push(ev(at, 'deck:put-bottom', { playerId, order: top.map((c) => c.uid) }));
  return { events: e.events, revealed: top, state: e.state };
}

/**
 * 召唤一个**衍生物**（docs/17 §4：星灵）。
 *
 * 衍生物在卡池里有定义但没有实例，故不能用 `card:moved` —— 用 `card:created`
 * 由 reducer 追加实例。uid 由 `PlayerState.tokenSeq` 决定，保证回放可复现。
 */
export function summonToken(
  at: number,
  state: GameState,
  owner: PlayerId,
  defId: string,
  ctx: RuleContext,
): GameEvent[] {
  const p = state.players[owner];
  if (!p) return [];
  const def = ctx.cards[defId];
  if (!def) return [];
  if (p.zones.board.length >= BOARD_SLOTS) return [];
  const uid = `${owner}#token${p.tokenSeq}`;
  return [ev(at, 'card:created', { playerId: owner, uid, defId, to: 'board' })];
}

/* ------------------------------ 除外 ------------------------------ */

/**
 * 将一张卡除外，并结算「除外时」触发（炎刃战旗：每回合一次抽 1）。
 *
 * 所有除外动作都必须走这里 —— 直接发 `card:moved` 会漏掉战旗。
 */
export function exileCard(
  at: number,
  state: GameState,
  playerId: PlayerId,
  uid: string,
  cards: Record<string, CardDef>,
  opts: { silentBanner?: boolean } = {},
): { events: GameEvent[]; state: GameState } {
  const loc = locate(state, uid);
  if (!loc || loc.playerId !== playerId) return { events: [], state };
  const e = emitter(state);
  e.push(ev(at, 'card:moved', { playerId, uid, from: loc.zone, to: 'exile' }) as GameEvent);

  const def = cards[loc.card.defId];
  if (def && isBladeCard(def) && !opts.silentBanner) {
    const p = e.state.players[playerId];
    if (p) {
      for (const b of p.zones.spell) {
        if (cards[b.defId]?.defId !== 'bladeBanner') continue;
        const key = `${b.uid}:banner`;
        if (p.effectsUsed.includes(key)) continue;
        e.push(ev(at, 'effect:used', { playerId, key }));
        const d = drawTop(at, e.state, playerId, 1);
        e.push(...d.events);
      }
    }
  }
  return { events: e.events, state: e.state };
}

/* ------------------------------ 霜冻 ------------------------------ */

/**
 * 霜冻一个随从，并结算「被霜冻时」触发（ADR-0025）：
 *  - 裁决官Ⅱ：每回合一次，敌方随从被霜冻 → 抽 1；
 *  - 执法者：每回合最多 +2 力量。
 *
 * `by` = **施加霜冻的一方**（触发归属它）。
 */
export function freezeUnit(
  at: number,
  state: GameState,
  by: PlayerId,
  targetUid: string,
  cards: Record<string, CardDef>,
): { events: GameEvent[]; state: GameState } {
  const loc = locate(state, targetUid);
  if (!loc || loc.zone !== 'board') return { events: [], state };

  const e = emitter(state);
  e.push(ev(at, 'unit:frozen', { playerId: loc.playerId, uid: targetUid }));

  const byP = e.state.players[by];
  if (!byP) return { events: e.events, state: e.state };

  // 霜痕（docs/16 §6.3.2 / D-229）：**冻结敌方随从**即 +1 层，永久累积、不清零。
  // 与「裁决官 Ⅲ」同一口径 —— 卡面写的是被动，故挂在所有冻结来源共用的这里，
  // 不会出现「某张卡的冻结不给霜痕」。
  if (loc.playerId !== by) {
    e.push(ev(at, 'frost:mark', { playerId: by, amount: 1 }));
  }

  // 裁决官Ⅱ（被动）：仅当施加者是霜律裁决官持有者时生效。
  // 卡面「当一个敌方随从被霜冻时」—— 被冻的是对方的随从，故只在 by 的对手场上时触发；
  // 本函数是「由 by 施加」，天然满足该条件。
  const cmd = byP.zones.commander[0];
  if (cmd && cards[cmd.defId]?.defId === 'frostAdjudicator') {
    const key = `${cmd.uid}:2`;
    if (!byP.effectsUsed.includes(key)) {
      e.push(ev(at, 'effect:used', { playerId: by, key }));
      const d = drawTop(at, e.state, by, 1);
      e.push(...d.events);
    }
  }

  // 执法者：每回合最多 +2（用 effect:used 记两次额度，回合切换清零）。
  const p2 = e.state.players[by];
  if (p2) {
    for (const c of p2.zones.board) {
      if (cards[c.defId]?.defId !== 'frostEnforcer') continue;
      const used = [1, 2].filter((i) => p2.effectsUsed.includes(`${c.uid}:freeze${i}`)).length;
      if (used >= 2) continue;
      e.push(ev(at, 'effect:used', { playerId: by, key: `${c.uid}:freeze${used + 1}` }));
      e.push(ev(at, 'unit:modified', { playerId: by, uid: c.uid, tempPower: 1 }));
    }
  }

  return { events: e.events, state: e.state };
}

/* ------------------------------ 目标集合 ------------------------------ */

/** 敌方场上随从（霜冻 / 指定类效果的候选集）。 */
export function enemyBoard(state: GameState, me: PlayerId): CardInstance[] {
  const foe = state.seats.find((id) => id !== me);
  return foe ? (state.players[foe]?.zones.board ?? []) : [];
}

/** 己方场上随从。 */
export function ownBoard(state: GameState, me: PlayerId): CardInstance[] {
  return state.players[me]?.zones.board ?? [];
}
