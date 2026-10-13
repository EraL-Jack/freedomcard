/**
 * 起手换牌 —— `docs/06` A8-3 / A10-1。
 *
 * 原文顺序：选任意数量返回卡组底 → 从卡组顶抽满 5 张 → 再洗牌。
 * 三步严格照做，不调换顺序 —— 顺序变了「不会换到返回去的牌」这个性质就不成立。
 */

import {
  INITIAL_HAND,
  RULE_ERRORS,
  type CardInstance,
  type GameEvent,
  type GameState,
  type Intent,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import {
  baseGuard,
  deckShuffled,
  drawCards,
  ev,
  firstRejection,
  locate,
  moved,
  playerOf,
  rngAdvance,
  strListArg,
} from '../ops.js';
import { shuffle } from '../rng.js';

export const mulliganRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  const guard = firstRejection(
    baseGuard(state, intent),
    state.turn !== 1 || state.phase !== 'charge'
      ? { code: RULE_ERRORS.WRONG_PHASE, message: '起手换牌只在第一回合的充能阶段可用' }
      : null,
    state.players[intent.playerId]?.mulliganDone
      ? { code: RULE_ERRORS.MULLIGAN_DONE, message: '起手换牌只能进行一次' }
      : null,
  );
  if (guard) return { ok: false, error: guard };

  const p = playerOf(state, intent.playerId);
  if (!p) return { ok: false, error: { code: RULE_ERRORS.NOT_YOUR_TURN, message: '玩家不在本局' } };

  const returns = strListArg(intent.payload?.returns);
  if (!returns) {
    return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: 'returns 必须是 uid 数组' } };
  }

  const at = ctx.now;
  const hand = p.zones.hand;
  for (const uid of returns) {
    const loc = locate(state, uid);
    if (!loc || loc.playerId !== intent.playerId || loc.zone !== 'hand') {
      return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: `手牌中没有 ${uid}` } };
    }
  }

  const events: GameEvent[] = [];

  // ① 返回卡组底（`card:moved` 追加到末尾，而 deck[0] 是顶 → 末尾即底）
  const returning = new Map<string, CardInstance>();
  for (const uid of returns) {
    const card = hand.find((c) => c.uid === uid)!;
    returning.set(uid, card);
    events.push(moved(at, intent.playerId, uid, 'hand', 'deck'));
  }

  const remainingHand = hand.filter((c) => !returning.has(c.uid));
  const deckAfterReturn: CardInstance[] = [...p.zones.deck, ...[...returning.values()]];

  // ② 从卡组顶抽满 5 张
  const need = Math.max(0, INITIAL_HAND - remainingHand.length);
  const drawn = drawCards(
    at,
    intent.playerId,
    { deck: deckAfterReturn, graveyard: p.zones.graveyard },
    need,
    state.rngCursor,
  );
  events.push(...drawn.events);

  // ③ 再洗一次（确保不会换到返回去的牌）
  if (drawn.deck.length > 1) {
    const s = shuffle(state.rngCursor, drawn.deck);
    events.push(rngAdvance(at, drawn.deck.length - 1));
    events.push(deckShuffled(at, intent.playerId, s.items.map((c) => c.uid)));
  }

  events.push(ev(at, 'mulligan:done', { playerId: intent.playerId }));
  return { ok: true, value: events };
};
