/**
 * 阶段流转 —— `docs/06` A4-1 / A4-2 / A9 补充 1 / A10-3。
 *
 * 六阶段顺序固定、均不可跳过。这里把「进入某阶段的自动效果」也放在本文件：
 * 重置阶段清休眠 —— 它是阶段定义的一部分，不是独立机制。
 *
 * ⚠️ **抽牌不再是自动效果**（Era 2026-10-18）：进入抽牌阶段只重置
 * `drawnThisPhase`，抽牌由玩家点击卡组触发（`draw.ts`）；未抽牌时
 * 玩家不得推进到下一阶段。抽完后**自动推进**到下一阶段
 * （Era 2026-10-19，`drawForPhase` 内接续 `advanceOnce`）。
 */

import {
  COST_INCOME_PER_TURN,
  DRAW_PER_TURN,
  FIRST_TURN_DRAW,
  MAX_COST_CURVE,
  RULE_ERRORS,
  TURN_LIMIT,
  TURN_LIMIT_ROUNDS,
} from '@app/shared/constants';
import type { GameEvent, GameState, Intent, Phase, PlayerId, Result, Rejection, RuleContext } from '@app/shared/types';

import { ev, maxCostChanged, phaseChanged, takeFromDeck, turnChanged } from '../ops.js';
import { reduce } from '../reducer.js';
import { activePlayer } from '../state.js';

/** 阶段顺序 —— A4-1，索引即推进顺序。 */
export const PHASE_ORDER: readonly Phase[] = ['charge', 'reset', 'draw', 'main', 'battle', 'end'];

/**
 * 第 `turn` 个**己方回合**的最高费用 —— docs/16 §3.3：1 → 3 → 5 → 10。
 * 「各自回合数」由调用方传 `chargeCount`（拿到回合即 +1），不能用全局 `turn`，
 * 否则后手会白拿一档（ADR-0024）。
 */
export function maxCostForTurn(turn: number): number {
  const idx = Math.min(Math.max(turn, 1), MAX_COST_CURVE.length) - 1;
  return MAX_COST_CURVE[idx] ?? MAX_COST_CURVE[MAX_COST_CURVE.length - 1]!;
}

/**
 * 本回合抽牌阶段应抽的张数 —— 与旧自动抽牌口径一致（A9 补充 1 / A10-3）。
 *
 * ⚠️ **这个函数必须留在这里（`phase.ts`），不能搬回 `draw.ts`**：
 * `advanceOnce` 要用它判断「这一拍该不该停」，而 `draw.ts` 已经反向依赖 `phase.ts`
 * （`drawForPhase` 里接续推进），搬回去就是循环依赖。放在 `maxCostForTurn` 旁边也合适 ——
 * 两者都是「这个回合的数字」。
 *
 * 座位 0 = 先攻（`start.ts` 按掷骰结果重排过 `seats`），故「先攻第一回合」= `turn 1 && seat 0`。
 */
export function drawCountFor(state: GameState): number {
  return state.turn === 1 && state.activeSeat === 0 ? FIRST_TURN_DRAW : DRAW_PER_TURN;
}

/**
 * 推进**一个**阶段，返回产生的事件（含进入该阶段的自动效果）。
 *
 * 导出给 `turn-end.ts` 复用 —— 超时 / 主动结束回合走的必须是同一条路径，
 * 否则「系统代打的回合」会和「玩家自己打的回合」产生不同的副作用。
 */
export function advanceOnce(state: GameState, ctx: RuleContext): GameEvent[] {
  const at = ctx.now;

  /*
   * 换牌阶段（D-262）**不是回合里的阶段**，这里必须直接返回空。
   *
   * `PHASE_ORDER.indexOf('mulligan')` 是 -1，若不在这里挡住，下面的 `else` 分支
   * 会把它当成「结束阶段之后」→ 直接 `turn + 1` 进下一回合。人机局的真实表现：
   * AI 先手、提交换牌后又被调度一拍，`decideAiMove` 落到兜底 `phaseAdvance`，
   * 于是玩家的换牌阶段被瞬间推走、开局直接跳到「第 2 回合 · 充能」——
   * 玩家从没看见过换牌界面（Era 2026-10-21 实机反馈）。
   *
   * 返回 `[]` 而不是抛错：`turnEndRule` 的循环靠「空步」自然收尾，
   * 这样任何来源的推进（玩家 / AI / 超时兜底）在换牌阶段都变成空操作。
   */
  if (state.phase === 'mulligan') return [];

  const idx = PHASE_ORDER.indexOf(state.phase);
  const active = activePlayer(state);
  const events: GameEvent[] = [];

  if (idx >= 0 && idx + 1 < PHASE_ORDER.length) {
    const to = PHASE_ORDER[idx + 1]!;
    events.push(phaseChanged(at, state.phase, to));

    if (active) {
      // A4-1 重置阶段：清除己方随从的休眠态（A9-2）
      if (to === 'reset') {
        events.push(ev(at, 'units:reset', { playerId: active }));
      }
      // 抽牌阶段**不自动抽**（Era 2026-10-18）：抽牌 = 玩家点击卡组（`draw.ts`）。
      // reducer 在进入 draw 阶段时把 `drawnThisPhase` 重置为 false。
    }

    // Era 2026-10-18：**重置阶段自动运行、自动推进，不需要手动点**。
    // 实现为状态机瞬穿：进入 reset 后立刻继续推进到下一阶段，
    // 事件流完整保留（phase:changed ×2 + units:reset，A4-2 不破），
    // 「停顿一下 + 动画展示」由客户端的事件播放节奏呈现，不进状态机。
    if (to === 'reset') {
      const s2 = events.reduce(reduce, state);
      events.push(...advanceOnce(s2, ctx));
      return events;
    }

    /*
     * issue #109（Era 2026-10-21）：「先攻第一回合不抽牌…直接自动推进阶段就行了。」
     *
     * 抽 0 张的抽牌阶段**没有决策点**：手动抽牌是 Era 2026-10-18 定的口径，
     * 而这里根本没有牌可抽 —— 界面上却照样亮「点击抽牌」，点了什么也不发生，
     * 玩家还不能自己推进（`phaseRule` 拒绝未抽牌的抽牌阶段），等于逼人点一次空按钮。
     *
     * 与 reset 同构的处理：进 draw 后立刻补 `draw:completed` 再继续推进。
     * **张数知识仍只有 `drawCountFor` 一处**，客户端不需要复制「第一回合不抽」这条规则 ——
     * 这是选 ① 而不是「前端按张数隐藏按钮」的理由（那会把规则搬到前端，迟早分叉）。
     */
    if (to === 'draw' && active && drawCountFor(state) === 0) {
      events.push(ev(at, 'draw:completed', { playerId: active }));
      const s2 = events.reduce(reduce, state);
      events.push(...advanceOnce(s2, ctx));
      return events;
    }
    return events;
  }

  // 结束阶段之后 → 进入下一回合
  const nextSeat = state.seats.length > 1 ? (state.activeSeat + 1) % state.seats.length : state.activeSeat;
  const nextTurn = state.turn + 1;
  const nextPlayer: PlayerId | undefined = state.seats[nextSeat];

  // docs/16 §7（D-237 修订，Era 2026-10-21）：40 轮**不再判和**。
  // 改为：比指挥官血量 → 高者胜；血量相同 → 进入**即死模式**，此后任何一方掉血即判负。
  // 全局回合 = 轮次 × 2，`nextTurn > TURN_LIMIT` 即「第 41 轮的第一手」。
  // 已进入即死模式后不再重复裁定（否则每次换手都会再判一次）。
  if (nextTurn > TURN_LIMIT && !state.suddenDeath) {
    const [a, b] = state.seats;
    const ha = a ? (state.players[a]?.health ?? 0) : 0;
    const hb = b ? (state.players[b]?.health ?? 0) : 0;
    if (a && b && ha !== hb) {
      events.push(ev(at, 'game:ended', { winner: ha > hb ? a : b, reason: 'turn-limit' }));
      return events;
    }
    // 同血量（或座位异常到无法比较）→ 即死模式，对局继续。
    events.push(ev(at, 'sudden:death', { round: TURN_LIMIT_ROUNDS }));
  }

  events.push(phaseChanged(at, state.phase, 'charge'));
  events.push(turnChanged(at, nextTurn, nextSeat));
  if (nextPlayer) {
    // docs/16 §3.3：按**各自回合数**取上限（turn:changed 会让 chargeCount +1）。
    const ownTurn = (state.players[nextPlayer]?.chargeCount ?? 0) + 1;
    events.push(maxCostChanged(at, nextPlayer, maxCostForTurn(ownTurn)));
    // docs/16 §2 充能①：强制收入 2 张（卡组顶 → 费用区，ADR-0024）。
    const p = state.players[nextPlayer];
    if (p) {
      const income = takeFromDeck(
        at,
        nextPlayer,
        { deck: p.zones.deck, graveyard: p.zones.graveyard },
        COST_INCOME_PER_TURN,
        state.rngCursor,
        'cost',
      );
      events.push(...income.events);
      /*
       * D-258（Era 2026-10-21「过回合时充能阶段显示不明显」）：
       * 回合开始的自动充能单独记一条汇总事件。
       *
       * 为什么不让客户端自己从 `card:moved` 里数：那两行和「玩家手动充能」长得完全一样，
       * 界面上只能读出一句「X 置入费用区」，读不出「这是回合开始白给的 2 张」。
       * 汇总进事件流之后，日志、横幅、回放看到的是同一件事。
       */
      if (income.events.length > 0) {
        events.push(ev(at, 'cost:income', { playerId: nextPlayer, amount: income.events.length }));
      }
    }
    // 指挥官力量值已取消（docs/16 §6.2.1 / D-230）：这里不再同步任何档位。
  }
  return events;
}

export const phaseRule = (
  state: GameState,
  intent: Intent,
  ctx: RuleContext,
): Result<GameEvent[], Rejection> => {
  if (!state.started) {
    return { ok: false, error: { code: RULE_ERRORS.NOT_STARTED, message: '对局尚未开始' } };
  }
  if (state.winner !== null || state.draw) {
    return { ok: false, error: { code: RULE_ERRORS.GAME_OVER, message: '对局已结束' } };
  }
  if (intent.actor === 'player' && activePlayer(state) !== intent.playerId) {
    return { ok: false, error: { code: RULE_ERRORS.NOT_YOUR_TURN, message: '不是你的回合' } };
  }
  /*
   * 换牌阶段（D-262）不属于回合，没有「推进阶段」这回事。
   *
   * 显式拒绝而不是靠 `advanceOnce` 返回空数组：空数组是 `ok: true`，
   * AI 兜底 / 超时链路会以为推进成功，日志里一片干净，问题只能靠实机发现。
   */
  if (state.phase === 'mulligan') {
    return { ok: false, error: { code: RULE_ERRORS.WRONG_PHASE, message: '开局换牌阶段不能推进' } };
  }
  // Era 2026-10-18：抽牌必须点击卡组完成 —— 未抽牌的抽牌阶段**禁止推进**
  // （阶段不可跳过的含义随手动抽牌延伸到「阶段动作不可跳过」）。
  // 系统 Intent（超时）不受此限：由 `turn-end.ts` 兜底自动抽牌。
  if (intent.actor === 'player' && state.phase === 'draw' && !state.drawnThisPhase) {
    return {
      ok: false,
      error: { code: RULE_ERRORS.WRONG_PHASE, message: '请先点击卡组抽牌' },
    };
  }
  return { ok: true, value: advanceOnce(state, ctx) };
};
