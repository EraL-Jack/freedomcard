import type { GameState, PlayerId } from '@app/shared/types';
import { MULLIGAN_WINDOW_MS } from '@app/shared/constants';

/**
 * 「现在能不能做某个操作」的纯判定（T-04）。
 *
 * ## 为什么从组件里搬出来
 *
 * 这些判定原来内联在 `TableScreen` 的组件体内 —— 3849 行组件零单测，
 * 而「什么阶段能充能 / 换牌窗口什么时候关 / 待定选择期间还能点哪些按钮」
 * 恰恰是最容易改错的逻辑：它们决定**按钮展不展示**，错了要么点了没反应，
 * 要么规则允许却没入口（D-152 就是这么发现的）。
 *
 * 搬成纯函数之后：状态进、布尔出，不需要渲染、不需要 DOM，可以直接断言。
 *
 * ## 纪律：只读状态，不做规则推算
 *
 * 这里判的每一条都是**状态直读**（阶段 / 回合归属 / 休眠 / 次数），
 * 与服务端守卫一一对应。它决定「按钮展不展示」，**不决定操作是否合法** ——
 * 权威判定永远在服务端（ADR-0002）。两边口径不一致时以服务端为准，
 * 客户端只是提前把必然被拒的按钮藏起来。
 */

export interface Actionability {
  /** 是否轮到我行动。 */
  myTurn: boolean;
  /** 是否有挂给我方的待定选择 —— 此刻引擎只放行「回答选择」和「认输」。 */
  choiceOpen: boolean;
  /** 手牌可点选（充能 / 主要阶段）。 */
  canPickHand: boolean;
  /** 随从可宣告攻击（战斗阶段）。 */
  canBattle: boolean;
  /** 换牌窗口：己方首个充能阶段 + 时间窗内 + 本局还没换过。 */
  canMulligan: boolean;
  /** 换牌模式本身还开着（阶段与时间窗都在，但可能已换过）。 */
  mulliganOpen: boolean;
  /** 抽牌阶段未抽牌，卡组区可点击抽牌。 */
  canDraw: boolean;
  /** 指挥官可攻击（每战斗阶段一次、非先攻方第一回合）。 */
  canCommanderAttack: boolean;
  /** 星轨观测者的「攻击时【1】展示」入口是否可用。 */
  canRevealAttack: boolean;
}

/**
 * 一次性算出全部可操作性。
 *
 * @param now 客户端本地时间 —— 仅用于换牌时间窗的**展示**；
 *            权威的窗口判定在服务端 `mulligan.ts`。
 */
export function actionability(state: GameState, me: PlayerId, now: number): Actionability {
  const mine = state.players[me];
  const myTurn = state.seats[state.activeSeat] === me;
  const phase = state.started ? state.phase : null;
  const choiceOpen = state.pendingChoice !== null && state.pendingChoice.playerId === me;

  const canPickHand = myTurn && (phase === 'charge' || phase === 'main');
  const canBattle = myTurn && phase === 'battle';

  /*
   * 换牌窗口（A8-3/A10-1 + X-17 + Era 2026-10-19「换牌加时间窗」）：
   * 基准是**各自首次进入己方充能阶段**（`firstChargeAt`），不是开局时刻 ——
   * 后攻方的首个充能阶段在下一回合，按开局起算会让它永远落在窗外。
   */
  const firstChargeAt = mine?.firstChargeAt ?? null;
  const timeOpen = firstChargeAt === null || now - firstChargeAt <= MULLIGAN_WINDOW_MS;
  const mulliganOpen = myTurn && phase === 'charge' && timeOpen;
  // 「第一次」由 chargeCount 判定：本局第一个充能阶段，且本人还没换过
  const canMulligan = mulliganOpen && (mine?.chargeCount ?? 0) === 1 && mine?.mulliganDone !== true;

  const canDraw = myTurn && phase === 'draw' && !state.drawnThisPhase && !choiceOpen;

  /* 指挥官攻击（docs/16 §6.1）：战斗阶段、本回合未攻击、非先攻方第一回合。
     `!choiceOpen` 与 D-152 同口径 —— 待定选择挂起时攻击必然被拒。 */
  const canCommanderAttack =
    myTurn &&
    phase === 'battle' &&
    !choiceOpen &&
    mine?.commanderAttacked !== true &&
    !(state.turn === 1 && state.activeSeat === 0) &&
    (mine?.zones.commander.length ?? 0) > 0;

  /* 星轨观测者「攻击时【1】」（docs/17 §3）：付 1 费先展示再结算伤害。 */
  const canRevealAttack =
    canCommanderAttack &&
    mine?.zones.commander[0]?.defId === 'starWatcher' &&
    (mine?.zones.cost.length ?? 0) >= 1 &&
    (mine?.usedCostThisTurn ?? 0) + 1 <= (mine?.maxCost ?? 0);

  return {
    myTurn,
    choiceOpen,
    canPickHand,
    canBattle,
    canMulligan,
    mulliganOpen,
    canDraw,
    canCommanderAttack,
    canRevealAttack,
  };
}
