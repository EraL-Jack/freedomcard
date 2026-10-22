import { drawCountFor } from '@app/core';
import type { GameState, PendingChoice, Phase, PlayerId } from '@app/shared/types';

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

  /*
   * 终局（issue #154）—— 结算改成**覆盖层**之后，牌桌不再被替换掉，仍在下面渲染。
   * 于是「可操作性」必须自己知道对局已经结束：否则 `phase` 停在 battle 且轮到我方时，
   * 界面照常给出「推进阶段 / 结束回合 / 认输」，点下去只会被服务端一句 `GAME_OVER` 拒掉
   * —— 界面在承诺引擎已经不认的动作（ADR-0002：界面口径必须与引擎一致）。
   *
   * `choiceOpen` 保持原值：万一终局时还挂着待定选择，回答它仍然是引擎允许的，
   * 这里把它一并禁掉反而会把玩家卡在浮层里。
   */
  if (state.winner !== null || state.draw) {
    return {
      myTurn: false,
      choiceOpen,
      canPickHand: false,
      canBattle: false,
      canMulligan: false,
      mulliganOpen: false,
      canDraw: false,
      canCommanderAttack: false,
      canRevealAttack: false,
    };
  }

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
   * 这里只管**界面给不给入口**；时间窗由服务端计时器裁决（D-267 起换牌窗口
   * 跟随房间回合时限），到点它会替未确认方提交「跳过」，阶段随即关闭。
   */
  const mulliganOpen = phase === 'mulligan' && mine?.mulliganDone !== true;
  const canMulligan = mulliganOpen;

  /*
   * 抽 0 张的阶段没有决策点（issue #109），引擎已经「进 draw 后若该抽 0 张就自动推进」
   * （`phase.ts` 的 `advanceOnce` + `shouldAutoAdvanceDraw`）。
   *
   * 剩下的唯一窗口是客户端的事件播放节奏 —— `phase:changed` 每条停 750ms，
   * 自动推进那一批中间必然有一两帧 `phase === 'draw'`。那时若照常给按钮，
   * 玩家会点到一个「服务端早已在主要阶段」的动作，换回一句 `WRONG_PHASE` 报错。
   *
   * ⚠️ 这个守卫**不是**「先攻首回合专用」（issue #139 / D-287）：首回合现已抽 1 张，
   *     它会正常停在 draw 并给按钮；`drawCountFor(state) > 0` 挡的只是「0 张的中间帧」。
   *
   * 张数判定直接用引擎的 `drawCountFor` —— **不复制「哪一回合抽几张」这条规则**，
   * 前端与引擎读同一个函数，口径不会分叉（ADR-0002：客户端不推算规则）。
   */
  const canDraw =
    myTurn && phase === 'draw' && !state.drawnThisPhase && !choiceOpen && drawCountFor(state) > 0;

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

/** 回合归属的色调 —— 界面据此选文字颜色（不在这里拼 class）。 */
export type TurnTone = 'mine' | 'foe' | 'pending';

export interface TurnGuidance {
  /** 「现在该做什么」的阶段提示文案；空串 = 不显示。 */
  hint: string;
  /** 顶栏的回合归属文案；`null` = 此刻不归这里管（换牌阶段有自己的状态条）。 */
  label: string | null;
  /** 归属色调。 */
  tone: TurnTone;
}

/** 回合边界正在播放时，顶栏显示这个而不是「你的回合 / 对手回合」（D-268）。 */
export const TURN_SWITCHING_LABEL = '回合切换中…';

/**
 * 回合内的「该做什么」提示 + 顶栏归属文案（D-258 / D-268）。
 *
 * ## 为什么需要 `turnChangePending`
 *
 * 客户端播放事件是**逐条 reduce + 按节奏停顿**的（`FX_MS`），一个回合边界在事件流里
 * 是两条：`phase:changed(… → charge)` 与紧随其后的 `turn:changed`。分开渲染就会出现
 * 一帧「阶段已经是充能、`activeSeat` 还是上一家」的**半批状态** —— 这个局面从来没有
 * 真实存在过（第 N 回合的充能阶段早就过去了）。
 *
 * 若照着它给指引，结束回合的那一方会看到「你的回合 · 充能阶段：点手牌里的随从…」，
 * 停 750ms 后回合才交给对手（Era 2026-10-21 issue #101：充能阶段的提示在切换回合之前显示了）。
 *
 * 所以：**回合归属只信「已落地」的状态**。边界在播时既不给指引，也不宣称是谁的回合。
 *
 * @param turnChangePending 队列里还有 `turn:changed` 没应用（`useRoom` 提供）
 */
export function turnGuidance(
  state: GameState,
  me: PlayerId,
  turnChangePending: boolean,
): TurnGuidance {
  // 换牌（D-259）不属于任何回合，顶栏由换牌状态条负责，这里不掺和。
  if (!state.started || state.phase === 'mulligan') return { hint: '', label: null, tone: 'foe' };

  if (turnChangePending) return { hint: '', label: TURN_SWITCHING_LABEL, tone: 'pending' };

  const myTurn = state.seats[state.activeSeat] === me;
  const label = myTurn ? '你的回合' : '对手回合';
  const tone: TurnTone = myTurn ? 'mine' : 'foe';
  // 对方回合不讲解「你该做什么」—— 讲了他也做不了，只会和桌面上的禁用态打架。
  if (!myTurn) return { hint: '', label, tone };

  // 待定选择挂起时只放行「回答 + 认输」，不给别的指引（D-152 口径）。
  if (state.pendingChoice !== null && state.pendingChoice.playerId === me) {
    return { hint: '', label, tone };
  }

  const hint =
    state.phase === 'charge'
      ? '充能阶段：点手牌里的随从 →「充能」放进费用区（每回合开始已自动 +2 张）'
      : state.phase === 'draw'
        ? // 0 张的抽牌阶段没有动作可做（引擎会自动推进，这里只在播放中间帧出现）；
          // 首回合自 #139 起抽 1 张，会走到下面那支正常给指引
          drawCountFor(state) > 0
          ? '抽牌阶段：点你的卡组区抽一张'
          : ''
        : state.phase === 'main'
          ? '主要阶段：点手牌 →「出牌」；出随从时点格子选位置，有随从的格子会被顶替'
          : state.phase === 'battle'
            ? '战斗阶段：点我方随从（或指挥官）→ 点对方目标'
            : '';

  return { hint, label, tone };
}

/**
 * 待定选择浮层里「卡片选项」该不该标阵营（issue #105）。
 *
 * 统领Ⅰ的 5 档破坏改成候选含对手场上之后，同一张卡可能同时出现在两边
 * （镜像对局时名字、费用、力量完全一样），只靠卡名分不清点的是谁家的随从。
 *
 * 纪律：**只有候选真的跨了双方**才标注。单边列表（冻结敌方、检视己方弃牌区等）
 * 一律返回空表 —— 每个选项都挂「敌方」只是噪声。
 */
export function choiceSideLabels(
  state: GameState,
  choice: PendingChoice,
): Readonly<Record<string, '我方' | '敌方'>> {
  const owner = new Map<string, PlayerId>();
  for (const [pid, p] of Object.entries(state.players)) {
    for (const zone of Object.values(p.zones)) for (const card of zone) owner.set(card.uid, pid);
  }
  const sides = new Set(choice.options.map((o) => owner.get(o)).filter(Boolean));
  if (sides.size < 2) return {};
  const out: Record<string, '我方' | '敌方'> = {};
  for (const opt of choice.options) {
    const pid = owner.get(opt);
    if (pid !== undefined) out[opt] = pid === choice.playerId ? '我方' : '敌方';
  }
  return out;
}

/**
 * 拖拽松手后该做什么（issue #108）—— `onDragUp` 里原来那串 DOM 分支的纯函数版。
 *
 * 为什么搬出来：那段代码按 DOM 标记手写，**没有任何单测能覆盖组合**，
 * 于是「法术拖到随从格」这种落点一直带着一个非法 `slot` 传给规则层，
 * 换回一句「只有随从需要指定位置」的报错（Era 现场：法术拖到哪都放不出来）。
 *
 * 落点语义（与 `TableScreen` 的 `data-drop*` 标记一一对应）：
 *  - `spell`：我方法术区 —— 法术 / 设置法术在这里出牌，**不带位置**；
 *  - `board` / 带 `slot`：我方随从区 —— 随从带位置出牌；法术/设置法术**也照出**（忽略位置），
 *    不把非法 slot 传下去（规则层的守卫保留，前端只是不制造非法请求）；
 *  - `cost`：费用区 —— 只在充能阶段等于「充能」；
 *  - `uid`：某张卡（攻击目标）。
 *
 * ⚠️ 这里只判「拖拽这种输入手势怎么映射成 Intent」，不判规则合法性 ——
 * 能不能出牌、够不够费仍由服务端裁决（ADR-0002）。
 */
export type DropIntent =
  | { kind: 'play'; slot?: number }
  | { kind: 'charge' }
  | { kind: 'attack'; targetUid: string }
  | { kind: 'none' };

export interface DragDropInput {
  /** 拖动源：手牌 或 场上随从。 */
  dragging: 'hand' | 'minion';
  phase: Phase;
  /** 拖动的手牌类型（`dragging === 'hand'` 时用）。 */
  cardType?: 'minion' | 'spell' | 'continuous' | 'commander';
  /** `data-drop` 命中值（`board` / `cost` / `spell` / `uid`）。 */
  drop?: string;
  /** `data-drop-slot` 命中值（随从格序号，字符串形态与 DOM 一致）。 */
  slot?: string;
  /** `data-drop-uid` 命中值（攻击目标）。 */
  targetUid?: string;
}

export function dragDropIntent(input: DragDropInput): DropIntent {
  const { dragging, phase, cardType, drop, slot, targetUid } = input;

  if (dragging === 'minion') {
    return targetUid ? { kind: 'attack', targetUid } : { kind: 'none' };
  }

  const isMinion = cardType === 'minion';
  const onBoard = drop === 'board' || slot !== undefined;

  if (drop === 'spell') {
    // 只收「不是随从」的牌；随从拖到法术区没有语义，按取消处理（B3-4）
    return phase === 'main' && !isMinion ? { kind: 'play' } : { kind: 'none' };
  }
  if (onBoard && phase === 'main') {
    // 随从带位置；法术与设置法术忽略格子号（它们没有位置概念）
    if (!isMinion) return { kind: 'play' };
    return slot === undefined ? { kind: 'play' } : { kind: 'play', slot: Number(slot) };
  }
  if (drop === 'cost') {
    // X-2：只有随从能充能 —— 法术拖到费用区不是「无效操作」，是「本来就不该充能」
    return phase === 'charge' && isMinion ? { kind: 'charge' } : { kind: 'none' };
  }
  return { kind: 'none' };
}
