import type { GameState, PlayerId } from '@app/shared/types';

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
  /** 换牌窗口：正处开局换牌阶段 + 自己还没确认（D-259）。 */
  canMulligan: boolean;
  /** 换牌阶段还没过（与「自己确认过没有」同义，保留独立字段供界面判按钮）。 */
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
 * @param _now 客户端本地时间 —— D-259 之后换牌窗口不再影响「给不给入口」
 *             （阶段本身就是换牌阶段），倒计时展示由组件自己算。
 *             保留参数是为了调用方签名稳定，也提醒「权威时间判定在服务端」。
 */
export function actionability(state: GameState, me: PlayerId, _now: number): Actionability {
  const mine = state.players[me];
  const myTurn = state.seats[state.activeSeat] === me;
  const phase = state.started ? state.phase : null;
  const choiceOpen = state.pendingChoice !== null && state.pendingChoice.playerId === me;

  const canPickHand =
    // 换牌阶段（D-259）：双方同时选要换掉的手牌，不依赖回合归属。
    (phase === 'mulligan' && !choiceOpen) ||
    (myTurn && (phase === 'charge' || phase === 'main'));
  const canBattle = myTurn && phase === 'battle';

  /*
   * 换牌窗口（D-259，Era 2026-10-21：「换牌这个动作不是在第一回合做，而是在游戏开始之前做」）。
   *
   * 旧口径挂在「各自第一个充能阶段」上（X-17），理由是后攻方要等一回合 ——
   * 现在换牌被提到开局前的独立阶段，双方同时进行，那个理由不再成立。
   *
   * 这里只管**界面给不给入口**；时间窗由服务端按 `startedAt` 判定，
   * 且「跳过」永远允许（否则窗口一过阶段就关不掉）。
   */
  const mulliganOpen = phase === 'mulligan' && mine?.mulliganDone !== true;
  const canMulligan = mulliganOpen;

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
