/**
 * 协议与状态的类型。
 *
 * 2026-10-13 更新：A 组规则输入已到位（`docs/06`），Era 已澄清「无独立充能区」，
 * 故本文件按 **ADR-0012** 定义对局状态结构。此前「禁止出现业务字段」的限制解除。
 *
 * 纪律不变：**本文件只放 Era 已给的东西**。未给的（如 `damage` 的取值范围、
 * 关键词表、卡池数据）一律留 `TODO(slot)` 或空位，不自行补齐。
 */

export type PlayerId = string;

/** Intent 的发起方。`system` 用于服务端构造的行为（如回合超时自动结束回合）。 */
export type IntentActor = 'player' | 'system';

/**
 * 卡牌类型 —— `docs/06` A6-1。
 *
 * `continuous` 的中文名是**设置法术**（Era 2026-10-19 定名，原「持续法术」）：
 * 设置在场上、结算后留在法术区。标识符保留 `continuous` 以兼容回放与协议。
 */
export type CardType = 'commander' | 'minion' | 'spell' | 'continuous';

/**
 * 阵营 —— 三套卡组各自的体系（`docs/12` 炎刃 / 霜律，`docs/17` 星轨）。
 *
 * 建房与加入时由玩家选择（D-235）；服务端据此装配 30 张主卡组 + 指挥官。
 */
export type Faction = 'blade' | 'frost' | 'star';

/**
 * 赛制 —— BO1 单局 / BO3 三局两胜（`docs/16` §1.3：座位偏差由赛制消化）。
 *
 * BO3 双方各先手一次；1:1 时第三局由前一局败者先攻（H33 / D-145）。
 */
export type MatchFormat = 'bo1' | 'bo3';

/**
 * 区域 —— ADR-0012，与 `docs/06` B2 布局逐项对应。
 *
 * ⚠️ **命名别名（ADR-0015）**：Era 的输入里，同一个区域出现过三个名字 ——
 * 「充能区」（X-2）、「费用区」（A5 补充 / B2 布局）、「伤害区」（卡牌样例卡面文本）。
 * **三者同一，都对应 `cost`**。
 *
 * 别名只存在于文档与注释，**不进代码标识符** —— 若再加一个 `'damage'` 枚举值，
 * 就等于制造了两个指向同一处的区域，后续所有按区域查找都要处理这个伪区分。
 */
export type Zone =
  | 'deck'
  | 'hand'
  | 'commander'
  | 'board'
  | 'spell'
  | 'cost'
  | 'graveyard'
  | 'exile';

/** 回合阶段 —— `docs/06` A4-1，顺序固定且均不可跳过（A4-2）。 */
export type Phase = 'charge' | 'reset' | 'draw' | 'main' | 'battle' | 'end';

/** 卡池中的一张卡**定义**（静态，不随对局变化）。 */
export interface CardDef {
  defId: string;
  name: string;
  type: CardType;
  /** 打出该卡支付的费用 —— `docs/06` A6 字段表：0–255 整数。 */
  cost: number;
  /** 力量值 —— 随从或指挥官：0–65535。 */
  power: number;
  /** 伤害值。`docs/06` 未给取值范围 → `TODO(slot)`。 */
  damage?: number;
  /** 关键词 —— `docs/06` A7 现仅 `'taunt'`，后续由 Era 补充。 */
  keywords?: string[];
  /**
   * **原始卡面文本** —— 转录自用，供 UI 展示与人工核对。
   *
   * ⚠️ **只存不解析**（ADR-0015 §2）：把卡面翻译成可执行效果是「发明规则」，
   * 而 `A7` 关键词表与触发时机均未给。所有效果一律保持 `TODO(slot)`。
   */
  text?: string;
  /**
   * **指挥官力量值曲线**（`docs/06` X-7，Era 2026-10-13：「初始 0，然后每个充能阶段成长，
   * 第一回合就会变到 1」）。
   *
   * 语义是**档位序列，不是回合号→力量的映射**：`[0,1,3,5]` 表示初始取第 0 档（值 0），
   * 每经过一次己方充能阶段推进一档，走到底后保持末档。
   *
   * ⚠️ 仅对 `type === 'commander'` 生效；**缺失时力量恒取 `power` 定值**（不成长）。
   * 原先放在 `attrs.powerCurve`（ADR-0015 §3 时期它只是「只记不用的转录数据」），
   * 现因参与结算而提升为一等字段 —— 避免对 `unknown` 做断言。
   */
  powerCurve?: readonly number[];
  /** 扩展位：Era 说明「字段清单我会给输入」，届时只加字段不改结构。 */
  attrs?: Record<string, unknown>;
}

/** 场上的一张**具体**卡（实例）。同名卡可有多份，故与 `CardDef` 分离（ADR-0012 §3）。 */
export interface CardInstance {
  /** 实例唯一 id —— 同名 3 张仍各有其 uid。 */
  uid: string;
  defId: string;
  /**
   * 休眠态。`docs/06` A9-2：随从**攻击后**变为休眠，重置阶段清除。
   * 注意：登场不产生休眠 —— Era 未定义「召唤失调」类机制，不得自行加入。
   */
  sleeping?: boolean;
  /** 本回合临时力量修正（统领 3 档 / 军师触发器，ADR-0023 §3）—— 回合切换时清空。 */
  tempPower?: number;
  /** 本回合「对指挥官伤害」临时加成（统领 7 档）—— 回合切换时清空。 */
  tempDamage?: number;
  /** 「一回合一次，攻击后重置」（统领 9 档，H23）：置位时下一次攻击后不进入休眠，生效一次即消耗。 */
  attackRefresh?: boolean;
  /**
   * 霜冻状态位（ADR-0025 / docs/12 §5）—— **不是卡面关键词**，随实例生灭。
   *
   * 语义：被霜冻的单位立即休眠；其控制者的下一个重置阶段跳过重置；
   * 该控制者回合的结束阶段解除（仍休眠）。不叠加：重复冻结只刷新一次跳过。
   */
  frozen?: boolean;
  /**
   * 「展示时：本回合此卡力量值 +N」落在**尚未在场**的卡上时的暂存位
   * （docs/17 §6.3 方案 A / D-235）。
   *
   * 被展示的卡可能还在卡组或手牌：把它记成「本回合它登场时获得 +N」，
   * 登场（`card:moved` → board）时由 reducer 消费成本回合 `tempPower`。
   */
  pendingPowerBuff?: number;
}

/** 回合内触发器（军师类「本回合获得效果」，ADR-0023 §7）。 */
export interface TurnTrigger {
  /** 触发器来源卡 uid（军师）。 */
  sourceUid: string;
  /** 归属玩家。 */
  owner: PlayerId;
  /** 触发类型 —— 目前仅「己方炎刃随从登场」。 */
  kind: 'on-blade-summon';
  /** 剩余可触发次数（发动时 = 除外区炎刃数）。 */
  remaining: number;
}

/**
 * 待定选择（ADR-0023 §2）—— 效果需要玩家选择时挂起。
 * 挂起期间引擎入口只放行该玩家的 `effect:choose` 与认输；
 * 通过 `choice:pending` / `choice:cleared` 事件进出状态（事件溯源一致）。
 */
export interface PendingChoice {
  /** 应回答的玩家。 */
  playerId: PlayerId;
  /** 选择种类 —— 由效果实现自定义（如 `blade-lord-1` / `blade-order-summon`）。 */
  kind: string;
  /** 效果来源卡 uid。 */
  sourceUid: string;
  /** 可选项 id 列表（卡 uid / 子效果编号），`'pass'` 恒隐含可选。 */
  options: string[];
  /** 效果私有上下文（如统领Ⅰ已用子效果 / 号令揭示的 uid 列表）。 */
  meta?: Record<string, unknown>;
}

export interface PlayerState {
  id: PlayerId;
  /**
   * 指挥官卡定义 id。**指挥官不进主卡组**（ADR-0012 补充：31 = 30 + 1），
   * 故它不是一个 `CardInstance`；在第一个充能阶段揭示时才生成实例置入指挥官区（X-1）。
   */
  commanderDefId: string;
  /** 血量 —— docs/16 §1 初始 **8**（ADR-0024）；归零判负（A3-1），下限 0。 */
  health: number;
  /** 最高费用 —— docs/16 §3.3：按**各自回合数**取 1→3→5→10，第 4 回合达上限。 */
  maxCost: number;
  zones: Record<Zone, CardInstance[]>;
  /** X-1：指挥官在第一个充能阶段揭示后直接置入指挥官区。 */
  commanderRevealed: boolean;
  /**
   * 指挥官力量值所处的**曲线档位** —— X-7（Era 2026-10-13）。
   *
   * 初始 `0`（曲线第一档）；**每次己方充能阶段**推进 1 档，走到底后保持末档。
   * 只有定义了 `powerCurve` 的指挥官才受它影响，其余一律取 `CardDef.power` 定值。
   *
   * 放在玩家级而非卡级：指挥官不进主卡组、没有实例序号（ADR-0012），
   * 与 `commanderDefId` 同属玩家自身的持久属性。
   */
  commanderPowerIndex: number;
  /** 起手换牌只允许一次（A10-1）。 */
  mulliganDone: boolean;
  /**
   * 首次进入**己方充能阶段**的时刻（事件时间戳）—— 换牌时间窗的计时基准
   * （X-17，Era 2026-10-19：双方都能换牌，窗口按各自起算，否则后攻方永远落在窗外）。
   * 先攻方在 `game:started` 时写入；后攻方在第一次拿到回合（turn:changed）时写入。
   */
  firstChargeAt: number | null;
  /**
   * 已进入己方充能阶段的次数 —— 换牌只允许在**第一次**（X-17）。
   * 不能只看 `firstChargeAt`：它无法区分「第一次充能」和「之后每个回合的充能」。
   */
  chargeCount: number;
  /** 本回合已发动的「每回合一次」效果（键 `${uid}:${effect}`，ADR-0023 §3）。 */
  effectsUsed: string[];
  /** 本回合生效中的触发器（军师类，回合切换清空）。 */
  turnTriggers: TurnTrigger[];
  /**
   * 本回合已消耗的费用张数 —— docs/16 §3.3：`maxCost` 是「本回合所有支付的
   * 总张数上限」，出牌与效果支付共用这一记帐。回合切换时清零。
   */
  usedCostThisTurn: number;
  /** 本回合指挥官是否已攻击（docs/16 §6.1：每个己方战斗阶段一次）。回合切换清零。 */
  commanderAttacked: boolean;
  /**
   * **霜痕**（docs/16 §6.3.2 / D-229）：每当一个敌方随从被冻结，获得 1 层。
   * 永久累积，不随冻结解除或随从离场而消失 —— 霜律的成长资源。
   */
  frostMark: number;
  /**
   * **星轨**（docs/17 §2.2 / D-230）：每展示 1 张卡 +1 层，永久累积、不清零 ——
   * 星轨的成长资源，只决定指挥官一次展示几张。
   */
  starTrack: number;
  /**
   * 本回合指挥官攻击的伤害加成（星轨侍僧「展示时：本回合你的指挥官伤害值 +1」）。
   * **不可叠加**：同一回合再翻到侍僧不再增加。回合切换清零。
   */
  commanderDamageBonus: number;
  /** 本回合打出下一张随从的额外减费（星轨传令）。回合切换清零，打出任意随从后消耗。 */
  nextMinionDiscount: number;
  /**
   * 衍生物序号 —— `card:created` 事件的 uid 来源（docs/17 §4：星灵）。
   *
   * 必须入状态：uid 要进 `stateHash`，用随机 id 会让两端哈希不一致（同 `makeUid` 的理由）。
   */
  tokenSeq: number;
}

/** 对局状态 —— 结构见 ADR-0012。 */
export interface GameState {
  /** 随机游标，必须入 state 否则洗牌不可复现（ADR-0010）。 */
  rngCursor: number;
  /** 开局种子，由服务端下发。 */
  seed: number;
  players: Record<PlayerId, PlayerState>;
  /** 座位顺序。`seats[0]` 为先攻方（A2-4：1d6 较大者先攻）。 */
  seats: PlayerId[];
  /** 当前行动方在 `seats` 中的下标。 */
  activeSeat: number;
  phase: Phase;
  /**
   * 本抽牌阶段是否已完成抽牌 —— Era 2026-10-18：抽牌改为**玩家点击牌组**触发，
   * 不再是进入抽牌阶段的自动效果。仅 `phase === 'draw'` 时有意义；
   * 进入抽牌阶段时由 reducer 重置为 `false`。
   */
  drawnThisPhase: boolean;
  /** 回合数，从 1 开始。 */
  turn: number;
  /** 是否已开局（完成洗牌、发牌、掷骰）。 */
  started: boolean;
  /**
   * 开局时刻（`game:started` 事件时间戳）—— 换牌时间窗（MULLIGAN_WINDOW_MS，
   * Era 2026-10-19）的计时基准。未开局时为 null。必须入 state：
   * 快照/回放都要能复现「窗口还剩多久」。
   */
  startedAt: number | null;
  /** 胜负：血空（A3-1）或认输（A3-4）后写入；平局时保持 null 且 `draw === true`。 */
  winner: PlayerId | null;
  /** 平局（docs/16 §7：40 轮未分胜负判和）。 */
  draw: boolean;
  /** 待定选择（ADR-0023）—— 非空时阻塞除回答/认输外的所有玩家 Intent。 */
  pendingChoice: PendingChoice | null;
  /**
   * 排队的待定选择（H28 / ADR-0031，Era 2026-10-19 拍板）。
   *
   * 场景：一个选择链**尚未结束时**又需要挂起新的选择（如统领Ⅰ从弃牌区召唤带登场选择的随从）。
   * `pendingChoice` 只有一个槽位，直接挂第二个会把前一个覆盖掉。故此时改为入队，
   * 等当前链条彻底结算完（最后一个 `choice:cleared` 之后），再由规则层依次出队触发。
   */
  pendingChoiceQueue: PendingChoice[];
}

/**
 * 玩家 / 系统发起的一次原子操作。
 * `seq` 由客户端按 playerId 单调递增，用于传输层去重（见 ADR-0011：去重归服务端 Room 层）。
 */
export interface Intent {
  type: string;
  actor: IntentActor;
  playerId: PlayerId;
  seq: number;
  /** 仅系统 Intent 携带，说明触发原因（如 `'timeout'`）。 */
  reason?: string;
  /** 操作参数。具体字段由各规则处理器校验。 */
  payload?: Record<string, unknown>;
}

/** 规则引擎产出的原子状态变更。 */
export interface GameEvent {
  type: string;
  /** 服务端时间戳 —— 全局唯一时间来源；core 内禁止读时钟。 */
  at: number;
  payload?: Record<string, unknown>;
}

/** 规则引擎拒绝 Intent 的原因。 */
export interface Rejection {
  code: string;
  message: string;
}

/** 规则处理器的返回类型：要么产出事件，要么给出拒绝理由（零副作用）。 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** 规则处理器的执行上下文。禁止含 IO、时钟与真随机源。 */
export interface RuleContext {
  /** 仅用于日志与事件时间戳的注入；core 内不得自行调用 Date.now()。 */
  now: number;
  /** 卡池定义 —— 规则处理器据此查 `cost` / `power` / 关键词。 */
  cards: Record<string, CardDef>;
}
