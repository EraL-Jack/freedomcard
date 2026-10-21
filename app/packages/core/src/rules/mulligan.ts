/**
 * 起手换牌 —— `docs/06` A8-3 / A10-1。
 *
 * 原文顺序：选任意数量返回卡组底 → 从卡组顶抽牌补满手牌 → 再洗牌。
 * 三步严格照做，不调换顺序 —— 顺序变了「不会换到返回去的牌」这个性质就不成立。
 *
 * 补牌张数（Era 2026-10-21 拍板，D-231）：**补到该玩家的起手张数**，
 * 即先手 5 张、后手 6 张（`docs/16 §1` 的后手补偿）。此前这里写死 `INITIAL_HAND`(5)，
 * 导致后手只要换 ≥1 张就永久少 1 张 —— 相当于换一次牌就把后手补偿吐回去。
 *
 * ## D-259（Era 2026-10-21）：换牌在**游戏开始之前**
 *
 * 原文三句话：「开局换牌有这个阶段吗，好像直接开始了啊，换牌这个动作不是在第一回合做，
 * 而是在游戏开始之前做。」
 *
 * 旧口径把换牌挂在「各自第一个充能阶段」（X-17），实际表现是：开局直接进入第一回合，
 * 换牌按钮藏在充能阶段的右下角，30 秒窗口一过就没了 —— 玩家根本不知道有这个阶段。
 *
 * 现在 `startRule` 之后停在**独立的 `mulligan` 阶段**（不属于任何回合）：
 *  - 双方**同时**可以换（不轮流动手，所以这里的守卫不能用 `baseGuard` 的回合判定）；
 *  - 各自确认一次即锁定（`mulliganDone`），先确认的等对方；
 *  - 双方都确认（或服务端超时兜底）→ `mulligan:closed` → 进入第一回合充能阶段。
 *
 * 时间窗（D-267 起）**不由本规则裁决**：换牌时长跟随该房间的回合时限，
 * 由服务端计时器到点后替未确认方提交「跳过」（`room/mulligan-timeout.ts`）。
 * 规则层只认「阶段是否还开着」—— 阶段关了，换牌自然被拒。
 */

import { INITIAL_HAND, SECOND_PLAYER_HAND, RULE_ERRORS } from '@app/shared/constants';
import type { CardInstance, GameEvent, GameState, Intent, Result, Rejection, RuleContext } from '@app/shared/types';

import {
  deckShuffled,
  drawCards,
  ev,
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
  const p = playerOf(state, intent.playerId);
  if (!p) return { ok: false, error: { code: RULE_ERRORS.NOT_YOUR_TURN, message: '玩家不在本局' } };

  /*
   * 守卫手写而不是用 `baseGuard`：它包含「必须轮到你行动」，
   * 而换牌阶段是**双方同时**操作，此时 `activeSeat` 还指向先攻方（还没轮到任何人行动）。
   */
  if (!state.started) {
    return { ok: false, error: { code: RULE_ERRORS.NOT_STARTED, message: '对局尚未开始' } };
  }
  if (state.winner !== null || state.draw) {
    return { ok: false, error: { code: RULE_ERRORS.GAME_OVER, message: '对局已结束' } };
  }
  if (state.phase !== 'mulligan') {
    return { ok: false, error: { code: RULE_ERRORS.WRONG_PHASE, message: '当前已不是开局换牌阶段' } };
  }
  if (p.mulliganDone) {
    return { ok: false, error: { code: RULE_ERRORS.MULLIGAN_DONE, message: '起手换牌只能进行一次' } };
  }

  const returns = strListArg(intent.payload?.returns);
  if (!returns) {
    /*
     * 这条是**入参契约**，不是给玩家看的提示：`returns` 必须显式给出（空数组 = 不换）。
     *
     * D-267 教训：服务端的换牌超时兜底原来漏了 `payload`，于是它自己被这条拒掉，
     * 换牌阶段关不掉。修法在调用方（`room/mulligan-timeout.ts`），
     * 这里**不改成「缺参数就当空数组」** —— 那会让「客户端漏发参数」永远查不出来。
     */
    return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: '换牌请求缺少 returns 参数' } };
  }

  /*
   * 时间窗**不在这里判**（D-267）。
   *
   * 原来这里按固定的 `MULLIGAN_WINDOW_MS` 拦「窗口过后换牌」，但换牌时长在 D-267
   * 改成跟随房间的回合时限（Era：「换牌时间也按每回合时间来定，不要固定值」），
   * 而 core 是纯函数、拿不到房间档位。两条路都会分裂真相：
   *   - 把档位塞进 `RuleContext` → 回放重验必须拿到同一个值，否则「实时接受、重放拒绝」；
   *   - 把档位写进 state → 改状态结构 + 影响 `stateHash`。
   *
   * 所以窗口**只由服务端计时器裁决**（`armMulliganTimer` → `handleMulliganTimeout`）：
   * 到点后它替未确认方提交「跳过」，阶段随即关闭。此后再提交换牌的拒绝原因是
   * 「当前已不是开局换牌阶段」—— 玩家看到的也就不会是内部字段名。
   */

  const at = ctx.now;
  const events: GameEvent[] = [];

  /*
   * 「确认」与「不换」是同一件事：`returns` 为空数组 = 保留整手。
   * 这时**不洗牌**——没返回任何卡，洗牌只会白白消耗随机游标，
   * 还会在日志里留下两条无意义的「洗牌」。
   */
  const hand = p.zones.hand;
  if (returns.length > 0) {
    for (const uid of returns) {
      const loc = locate(state, uid);
      if (!loc || loc.playerId !== intent.playerId || loc.zone !== 'hand') {
        return { ok: false, error: { code: RULE_ERRORS.CARD_NOT_IN_ZONE, message: `手牌中没有 ${uid}` } };
      }
    }

    // ① 返回卡组底（`card:moved` 追加到末尾，而 deck[0] 是顶 → 末尾即底）
    const returning = new Map<string, CardInstance>();
    for (const uid of returns) {
      const card = hand.find((c) => c.uid === uid)!;
      returning.set(uid, card);
      events.push(moved(at, intent.playerId, uid, 'hand', 'deck'));
    }

    const remainingHand = hand.filter((c) => !returning.has(c.uid));
    const deckAfterReturn: CardInstance[] = [...p.zones.deck, ...[...returning.values()]];

    // ② 从卡组顶抽牌补满手牌 —— 补到**该玩家的起手张数**（先手 5 / 后手 6，D-231）。
    //
    // 先手 = `seats[0]`（`startRule` 按掷骰结果重排座位，第 0 席恒为先攻方）。
    const handSize = state.seats[0] === intent.playerId ? INITIAL_HAND : SECOND_PLAYER_HAND;
    const need = Math.max(0, handSize - remainingHand.length);
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
  }

  events.push(ev(at, 'mulligan:done', { playerId: intent.playerId }));

  /*
   * 双方都完成 → 关闭换牌阶段（D-259）。
   *
   * 由**最后一个确认的人**触发，而不是等某个定时任务：换牌阶段结束的条件
   * 只有这一条，放在规则里就能保证「事件流完整、回放能复现」——
   * 由服务端事后补一条 `mulligan:closed` 会让回放与实时走在两条路径上。
   */
  const other = state.seats.find((id) => id !== intent.playerId);
  const otherDone = other ? state.players[other]?.mulliganDone === true : true;
  if (otherDone) {
    events.push(ev(at, 'mulligan:closed', { firstPlayer: state.seats[0] ?? '' }));
  }

  return { ok: true, value: events };
};
