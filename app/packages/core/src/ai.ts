/**
 * 人机对战的 AI 决策（D-242，Era 2026-10-21 新需求）。
 *
 * ## 为什么放在 core 而不是 server
 *
 * 这是一个**纯函数**：读到某个 `GameState`，吐出一条「我想做什么」。
 * 它不碰 socket、不读时钟、不自己改状态 —— 决策与执行彻底分开，
 * 于是可以像规则一样被单测覆盖（`ai.test.ts` 直接摆局面断言它选了哪张牌）。
 *
 * `now` 由调用方传入（会话层是唯一允许读时钟的地方），用于判断换牌时间窗。
 *
 * ## 设计取舍：为什么「一步只发一条 Intent」
 *
 * 引擎的每条 Intent 都会产出完整 `GameEvent[]` 并进回放。如果 AI 一次想把
 * 「抽牌 + 出牌 + 攻击」全做完，就得在服务端内部推演多次、绕开 `stateHash`，
 * 一旦某一步被拒，前几步已经落库 —— 状态与事件流对不上。
 * 所以 AI 与真人走**完全同一条链路**：一拍一条 Intent，由调度器按间隔驱动。
 *
 * ## 强度定位
 *
 * 目前是「能完整打完一局」的启发式，不是博弈 AI：
 * 铺场优先出贵的随从、攻击优先打掉最弱的敌方随从、前排挡不住时打脸。
 * 不做的：算斩杀、留牌、技能时机、为下回合铺路。
 * 强度可调，但**先保证不卡死** —— 调度器在 AI 操作被拒时会兜底推进阶段。
 */

import { BOARD_SLOTS, KEYWORD_TAUNT } from '@app/shared/constants';
import type { CardDef, CardInstance, GameState, PlayerId } from '@app/shared/types';

import { costToPay, defOf, hasKeyword, unitPower } from './ops.js';
import { INTENTS } from './rules/index.js';
import { commanderUid, opponentOf } from './state.js';

/** AI 想做的一件事 —— 与 `Intent` 同形，但**不含** `actor` / `seq`（那是会话层的职责）。 */
export interface AiMove {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * 这张手牌现在能打出吗（只看费用，不看效果是否需要目标）。
 *
 * 与 `playRule` 的算法**故意重复**：那边是权威校验（拒绝时人话报错），
 * 这边只是「不要发出明知会被拒的 Intent」。两边算法若哪天分叉，
 * 最坏结果是 AI 被拒一次、由调度器兜底推进，不会卡死。
 */
function affordable(
  me: GameState['players'][string],
  def: CardDef,
): boolean {
  const base = costToPay(def);
  const pay = def.type === 'minion' ? Math.max(0, base - me.nextMinionDiscount) : base;
  if (me.zones.cost.length < pay) return false;
  // 0 费不占额度（docs/16 §9 第 5 条）
  const budget = Math.max(0, me.maxCost - me.usedCostThisTurn);
  return pay <= budget;
}

/** 按「越贵越优先」排序的手牌（同样费用时随从优先 —— 铺场比对空放法术更稳）。 */
function playableHand(
  me: GameState['players'][string],
  cards: Record<string, CardDef>,
): CardInstance[] {
  // ⚠️ 满场不再过滤随从（D-257）：现在可以顶替，是否值得顶替由调用方按力量判断。
  return me.zones.hand
    .filter((c) => {
      const def = defOf(cards, c.defId);
      if (!def || def.type === 'commander') return false;
      return affordable(me, def);
    })
    .sort((a, b) => {
      const da = defOf(cards, a.defId);
      const db = defOf(cards, b.defId);
      const sa = (da?.cost ?? 0) + (da?.type === 'minion' ? 0.5 : 0);
      const sb = (db?.cost ?? 0) + (db?.type === 'minion' ? 0.5 : 0);
      return sb - sa;
    });
}

/**
 * 满场时找出最弱的那一格（D-257）。
 *
 * AI 顶替的唯一理由是把弱随从换成强随从 —— 换弱或换平只是白扔一张手牌，
 * 所以调用方要拿新随从的力量跟这里的返回值比一比。
 */
function weakestSlot(
  state: GameState,
  cards: Record<string, CardDef>,
  me: GameState['players'][string],
): { slot: number; power: number } | null {
  const board = me.zones.board;
  if (board.length === 0) return null;
  let bestSlot = board[0]!.slot ?? 0;
  let bestPower = unitPower(state, cards, board[0]!.uid) ?? 0;
  for (let i = 1; i < board.length; i++) {
    const c = board[i]!;
    const power = unitPower(state, cards, c.uid) ?? 0;
    if (power < bestPower) {
      bestPower = power;
      bestSlot = c.slot ?? i;
    }
  }
  return { slot: bestSlot, power: bestPower };
}

/**
 * 决定 AI 的下一手。返回 `null` = 「现在没我事」（不是我的回合 / 对局已结束）。
 *
 * @param _now 服务端时间戳 —— D-259 之后换牌不再判时间窗（`mulligan` 阶段任何时刻
 *             都能提交「跳过」），当前没有用到；保留参数是为了**调用方签名稳定**，
 *             且未来任何「看时间」的决策都必须从这里取而不许读时钟（core 禁止 IO）。
 */
export function decideAiMove(
  state: GameState,
  aiId: PlayerId,
  cards: Record<string, CardDef>,
  _now: number,
): AiMove | null {
  const me = state.players[aiId];
  if (!me || !state.started) return null;
  if (state.winner !== null || state.draw) return null;

  /*
   * ① 待定选择优先。
   *
   * 注意这里**不看是不是我的回合** —— 受伤展示会在对手回合给我挂选择
   * （Era 2026-10-21「P04 要能响应，因为掉血会展示卡牌有效果触发」）。
   * 选第一个可选项，没有选项就 pass：效果实现里 `'pass'` 恒隐式可选。
   */
  if (state.pendingChoice) {
    if (state.pendingChoice.playerId !== aiId) return null;
    return {
      type: INTENTS.effectChoose,
      payload: { choice: state.pendingChoice.options[0] ?? 'pass' },
    };
  }

  if (state.seats[state.activeSeat] !== aiId) return null;

  // ② 换牌：AI 不换（保留原起手就是它的最优解），但必须**主动提交**一次 ——
  //    否则要等 30s 兜底才轮到它行动，人机局第一分钟就卡住了。
  //    D-259：换牌在开局前的 `mulligan` 阶段，不再是「第一个充能阶段」。
  //    这里**不判时间窗**：窗口过后仍然允许「跳过」（否则阶段关不掉），
  //    而换牌本身对 AI 没有价值，所以任何时刻都发同一条空 returns。
  if (state.phase === 'mulligan' && !me.mulliganDone) {
    return { type: INTENTS.mulligan, payload: { returns: [] } };
  }

  // ③ 抽牌阶段：抽牌是手动点卡组触发的（Era 2026-10-18），不抽不能推进。
  if (state.phase === 'draw' && !state.drawnThisPhase) {
    return { type: INTENTS.draw };
  }

  // ④ 主要阶段：出一张付得起的牌；没有就推进。
  if (state.phase === 'main') {
    const full = me.zones.board.length >= BOARD_SLOTS;
    for (const cand of playableHand(me, cards)) {
      const def = defOf(cards, cand.defId);
      if (!def) continue;
      if (def.type === 'minion' && full) {
        // 满场 → 只在「更强」时顶替（D-257）。换弱/换平等于白扔一张牌。
        const weak = weakestSlot(state, cards, me);
        if (!weak || def.power <= weak.power) continue;
        return { type: INTENTS.play, payload: { uid: cand.uid, slot: weak.slot } };
      }
      return { type: INTENTS.play, payload: { uid: cand.uid } };
    }
    return { type: INTENTS.phaseAdvance };
  }

  // ⑤ 战斗阶段。
  if (state.phase === 'battle') {
    // 先攻方第一回合不可攻击（A10-3）—— 直接推进，免得白发一条必被拒的 Intent。
    const firstTurnLock = state.turn === 1 && state.activeSeat === 0;
    if (!firstTurnLock) {
      const foeId = opponentOf(state, aiId);
      const foe = foeId ? state.players[foeId] : null;

      const attackers = me.zones.board
        .filter((c) => !c.sleeping)
        .sort((a, b) => (unitPower(state, cards, b.uid) ?? 0) - (unitPower(state, cards, a.uid) ?? 0));

      if (attackers.length > 0 && foeId && foe) {
        const taunts = foe.zones.board.filter((c) => hasKeyword(defOf(cards, c.defId), KEYWORD_TAUNT));
        // 嘲讽在场时只能打嘲讽（A7）；否则打**力量最低**的随从（胜率最高）。
        // 对方随从区为空 → 打脸（前排规则，docs/16 §5.2）。
        const pool = taunts.length > 0 ? taunts : foe.zones.board;
        const pool2 = [...pool].sort(
          (a, b) => (unitPower(state, cards, a.uid) ?? 0) - (unitPower(state, cards, b.uid) ?? 0),
        );
        const targetUid = pool2[0]?.uid ?? commanderUid(foeId);
        return {
          type: INTENTS.attack,
          payload: { attackerUid: attackers[0]!.uid, targetUid },
        };
      }

      // 随从都动不了（场上空 / 全休眠）→ 指挥官攻击：每战斗阶段一次，不受前排限制（§6.1）。
      if (!me.commanderAttacked && me.zones.commander.length > 0) {
        return { type: INTENTS.commanderAttack };
      }
    }
    return { type: INTENTS.phaseAdvance };
  }

  // ⑥ 充能 / 结束阶段 → 推进（充能是自动收入，手牌充能 AI 不用）。
  return { type: INTENTS.phaseAdvance };
}
