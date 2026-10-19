/**
 * 开局 —— 洗牌（A8-1）、掷骰定先后手（A2-4）、揭示指挥官（X-1）、发起手牌（A10-1）。
 *
 * 顺序说明：先洗牌再掷骰，是为了让「随机消耗」的顺序固定 ——
 * 同一个 seed 必得同一结果，回放才能复现。
 *
 * 每次消耗随机的地方都必须紧跟一条 `rng:advance`，且步数与实际调用次数一致，
 * 否则回放时游标错位，后续所有随机全部偏离。
 */

import {
  INITIAL_HAND,
  RULE_ERRORS,
  SECOND_PLAYER_HAND,
  SEQUENCE_DIE,
  type CardInstance,
  type GameEvent,
  type GameState,
  type Intent,
  type PlayerId,
  type Result,
  type Rejection,
  type RuleContext,
} from '@app/shared';

import { drawCards, ev, deckShuffled, rngAdvance } from '../ops.js';
import { nextInt, shuffle } from '../rng.js';
import { commanderUid } from '../state.js';
import { checkDeck } from '../deck.js';

export const startRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  if (state.started) {
    return { ok: false, error: { code: RULE_ERRORS.ALREADY_STARTED, message: '对局已开始' } };
  }
  if (state.seats.length !== 2) {
    return { ok: false, error: { code: RULE_ERRORS.NOT_STARTED, message: '开局需要 2 名玩家' } };
  }

  // 卡组构成校验 —— 31 = 主卡组 30 + 指挥官 1（ADR-0012 补充）
  for (const id of state.seats) {
    const p = state.players[id];
    if (!p) return { ok: false, error: { code: RULE_ERRORS.NOT_STARTED, message: `玩家缺失: ${id}` } };
    const problem = checkDeck(p, ctx.cards);
    if (problem) {
      return { ok: false, error: { code: RULE_ERRORS.INVALID_DECK, message: problem } };
    }
  }

  const at = ctx.now;
  const events: GameEvent[] = [];
  let cursor = state.rngCursor;

  // ① 各自洗牌（A8-1：一次全随机）
  const shuffled = new Map<PlayerId, CardInstance[]>();
  for (const id of state.seats) {
    const deck = state.players[id]!.zones.deck;
    const s = shuffle(cursor, deck);
    cursor = s.nextCursor;
    events.push(rngAdvance(at, Math.max(0, deck.length - 1)));
    events.push(deckShuffled(at, id, s.items.map((c) => c.uid)));
    shuffled.set(id, s.items);
  }

  // ② 定先后手（A2-4：1d6 较大者先攻）
  //
  //   BO3 第 2 小局要求「双方各先手一次」（docs/16 §1.3），此时由会话层指定先手 ——
  //   `payload.firstPlayerId` 只允许是**在座玩家之一**，且只接受系统 Intent：
  //   玩家自己发这个字段等于掷骰作弊，故非系统来源一律忽略。
  const a = state.seats[0]!;
  const b = state.seats[1]!;
  const forced =
    intent.actor === 'system' && typeof intent.payload?.['firstPlayerId'] === 'string'
      ? String(intent.payload['firstPlayerId'])
      : '';
  const seats = forced === a || forced === b ? [forced, forced === a ? b : a] : null;

  let order: [PlayerId, PlayerId];
  if (seats) {
    order = seats as [PlayerId, PlayerId];
    events.push(ev(at, 'game:started', { seats: order, forced: true }));
  } else {
    const roll = rollSequence(cursor);
    cursor = roll.cursor;
    order = roll.a > roll.b ? [a, b] : [b, a];
    events.push(rngAdvance(at, roll.steps));
    events.push(ev(at, 'game:started', { seats: order, rolls: { [a]: roll.a, [b]: roll.b } }));
  }
  const seatsOut = order;

  // ③ 揭示指挥官（X-1：第一个充能阶段揭示后直接置入指挥官区）
  for (const id of seatsOut) {
    events.push(
      ev(at, 'commander:revealed', {
        playerId: id,
        uid: commanderUid(id),
        defId: state.players[id]!.commanderDefId,
      }),
    );
  }

  // ④ 第一回合的充能阶段（docs/16 §1/§2，D-227 修订）：
  //    **先攻首回合自动充能 0 张**（后攻与后续回合仍是 2 张）。
  //    指挥官没有力量值（docs/16 §6.2.1 / D-230），故不再同步任何档位。
  const firstPlayer = seatsOut[0]!;
  const firstDeck = shuffled.get(firstPlayer) ?? [];

  // ⑤ 发起手牌（docs/16 §1）：先手 5 张、后手 6 张。
  for (const id of seatsOut) {
    const deckNow = id === firstPlayer ? firstDeck : (shuffled.get(id) ?? []);
    const count = id === firstPlayer ? INITIAL_HAND : SECOND_PLAYER_HAND;
    const drawn = drawCards(at, id, { deck: deckNow, graveyard: [] }, count, cursor);
    events.push(...drawn.events);
  }

  return { ok: true, value: events };
};

/**
 * 掷骰 —— 双方各 1d6，较大者先攻（A2-4）。
 *
 * ⚠️ **假设（已登记假设清单）**：点数相同怎么办 Era 未给，此处按「重掷直到不同」。
 * 若日后改为「相同则座位靠前者先攻」之类，只改本函数，不动调用方。
 */
function rollSequence(cursor: number): { a: number; b: number; steps: number; cursor: number } {
  let c = cursor;
  let steps = 0;
  for (;;) {
    const ra = nextInt(c, SEQUENCE_DIE);
    const rb = nextInt(ra.nextCursor, SEQUENCE_DIE);
    c = rb.nextCursor;
    steps += 2;
    if (ra.value !== rb.value) return { a: ra.value + 1, b: rb.value + 1, steps, cursor: c };
  }
}
