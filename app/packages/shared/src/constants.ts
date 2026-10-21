/**
 * 与玩法无关的常量。
 *
 * 单独成文件是为了让 **client 可以只引本子路径**（`@app/shared/constants`），
 * 不经过 `index.ts`，从而不把 zod 拖进首屏产物（实测约 24 kB gzip）。
 */

/** Socket.IO 事件名 —— 禁止在业务代码里写字符串字面量。 */
export const SOCKET_EVENTS = {
  echo: 'echo',
  roomCreate: 'room:create',
  roomJoin: 'room:join',
  roomReconnect: 'room:reconnect',
  roomLeave: 'room:leave',
  /**
   * 准备 / 开始游戏 —— ADR-0019。
   *
   * 玩家只表达「我准备好了」，**不携带座位顺序与随机种子** —— 那两项由服务端
   * 权威决定，交给客户端等于开放先后手伪造与牌序预测。
   */
  roomReady: 'room:ready',
  roomState: 'room:state',
  /**
   * 开始下一小局 —— BO3 用（docs/16 §1.3 / D-132）。
   *
   * 只有房主能发起，且必须处于「上一小局已结束、系列赛未分胜负」的待开局状态。
   */
  roomNextGame: 'room:next-game',
  /**
   * 换卡组 —— D-141（Era 2026-10-19：对局前与准备页都能选）。
   *
   * 只在**未开局**时允许；开局后服务端拒 `DECK_LOCKED`。
   * payload 是 `{ deck: string[], commander?: string }`（30 个 defId + 指挥官，D-184）。
   * 空数组 = 回到服务端默认卡组；指挥官与卡组一起换，不再有「按阵营决定」。
   */
  roomDeck: 'room:deck',
  gameIntent: 'game:intent',
  gameEvents: 'game:events',
  gameSnapshot: 'game:snapshot',
} as const;

/**
 * 传输层超时常量（ADR-0010）。**禁止混用**：
 * - `RECONNECT_GRACE_MS`：断线后席位保留时长
 * - `TURN_TIMEOUT_MS`：回合内无操作，服务端自动结束回合的**默认**时长
 *
 * ⚠️ 两者当前数值相同（都是 60s）纯属巧合，**语义完全不同**：
 * 一个是「人不在位」的宽限，一个是「人不在动」的兜底。改任何一个都不该动另一个。
 *
 * H18（Era 2026-10-21）：「时长建议在建房能选择，30-60-180-999」——
 * 于是这条常量降级为**默认值**，真正生效的时限按房间（`Room.turnTimeoutMs`）取。
 */
export const RECONNECT_GRACE_MS = 60_000;

/** 建房里可选的回合时限（秒 → 毫秒）。Era 2026-10-21 定稿的四个档位。 */
export const TURN_TIMEOUT_OPTIONS = [30_000, 60_000, 180_000, 999_000] as const;

/**
 * 默认回合时限 —— 取 **60s**。
 *
 * 为什么不是 30s：8 血节奏下一个回合要「充能 → 推阶段 → 出牌 → 攻击」四步，
 * 30s 实测常被自动结束回合（`docs/21` P-08 / H18 的证据）。
 * 为什么不是 180s：默认值该照顾「正常打一局」，长时限留给主动选的人。
 */
export const TURN_TIMEOUT_MS = 60_000;

/**
 * 归一房间回合时限（H18）—— 只认白名单，其余一律回落默认值。
 *
 * 为什么**不**在 schema 里直接拒绝非法值：老客户端 / 手误传 120000 的人
 * 会拿到一个「参数不合法」的 400，而他其实只是想建房。
 * 回落默认值不会让任何人卡住，且禁止了「任意毫秒数」这种未定义档位。
 */
export function normalizeTurnTimeout(ms: unknown): number {
  return typeof ms === 'number' && (TURN_TIMEOUT_OPTIONS as readonly number[]).includes(ms)
    ? ms
    : TURN_TIMEOUT_MS;
}

/**
 * 人机对战的 AI 席位（D-242，Era 2026-10-21）。
 *
 * `playerId` **固定**而不是随机 UUID，理由有三：
 * 1. 一间房只有一个 AI，不需要唯一性；随机 id 反而让「哪张牌是电脑打的」难以肉眼排查。
 * 2. 真人的 `playerId` 是 randomUUID（36 字符），不会撞上 `'ai'`。
 * 3. 回放 / 日志里 `actor` 一眼可读。
 *
 * ⚠️ AI **不登记** `byPlayer`（它没有 socket、不会重连），也不参与 `prune` 的席位回收
 * —— 它的席位 `connected` 恒为 `true`。
 */
export const AI_PLAYER_ID = 'ai';
export const AI_NICKNAME = '电脑';

/**
 * AI 每步之间的间隔（毫秒）。
 *
 * 为什么不是 0：一步接一步地瞬间打完，玩家看到的是「事件齐刷刷蹦出来」，
 * 既看不懂发生了什么，也失去了「对面在思考」的反馈。
 * 600ms 是实测手感 —— 足够看清一次移动，又不至于等得不耐烦。
 */
export const AI_STEP_DELAY_MS = 600;

/**
 * 开局换牌时间窗的**默认值** —— Era 2026-10-19：「开局换牌需要加一个时间窗」。
 *
 * ⚠️ **D-267 起它只是兜底**：换牌窗口跟随该房间的回合时限（建房档位 30/60/180/999 秒，
 * Era 2026-10-21「换牌时间也按每回合时间来定，不要固定值」）。
 * 只有房间没设档位时才用到这个数（`server/src/room/mulligan-timeout.ts` 的 `mulliganWindowMs`）。
 *
 * 窗口到点由**服务端计时器**裁决：替未确认方提交「不换牌」，阶段随即关闭。
 * 规则层（`core/rules/mulligan.ts`）不读时间 —— 它拿不到房间档位，读了就会与计时器分裂。
 */
export const MULLIGAN_WINDOW_MS = 30_000;

/** 房间错误码 —— 传输层统一口径，客户端据此提示。 */
export const ROOM_ERRORS = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_ENDED: 'ROOM_ENDED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  GRACE_EXPIRED: 'GRACE_EXPIRED',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  /** 只有房主能开始下一小局（D-132）。 */
  NOT_HOST: 'NOT_HOST',
  /** 当前没有「上一小局已结束、等待开局」的状态。 */
  NO_NEXT_GAME: 'NO_NEXT_GAME',
  /** 自建卡组不合法（张数 / 同名上限 / 含指挥官 / 未知卡）。 */
  INVALID_DECK: 'INVALID_DECK',
  /** 只有未开局时才允许换卡组。 */
  DECK_LOCKED: 'DECK_LOCKED',
  /** 触发按连接 / 全局限流（ADR-0039）。 */
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type RoomErrorCode = (typeof ROOM_ERRORS)[keyof typeof ROOM_ERRORS];

/**
 * 房间错误码 → 中文（D-157）。
 *
 * 放在 shared 而不是客户端：**类型可以强制穷尽** —— 以后新增错误码，
 * 少写一条文案就会编译失败，而不是等玩家看到「操作失败（NOT_HOST）」。
 * 服务端回包若带了 `message`，仍以 `message` 为准（更具体）。
 */
export const ROOM_ERROR_TEXT: Readonly<Record<RoomErrorCode, string>> = {
  ROOM_NOT_FOUND: '房间不存在',
  ROOM_FULL: '房间已满',
  ROOM_ENDED: '对局已结束',
  INVALID_TOKEN: '重连凭据无效，请重新加入房间',
  GRACE_EXPIRED: '断线超过 60 秒，席位已释放',
  NOT_IN_ROOM: '你不在任何房间里',
  NOT_HOST: '只有房主能开始下一局',
  NO_NEXT_GAME: '当前没有等待开局的下一局',
  INVALID_DECK: '卡组不合法（需 30 张、同名 ≤3、不含指挥官）',
  DECK_LOCKED: '对局已开始，不能再换卡组',
  RATE_LIMITED: '操作太频繁，请稍等几秒再试',
};

/* ------------------------------------------------------------------ *
 * 玩法常量 —— 全部照抄 `docs/06` A 组的 Era 输入，不得自行推算。
 * 每条都注明来源，便于日后核对。
 * ------------------------------------------------------------------ */

/**
 * 最高费用增长序列 —— **按各自回合数**取值（docs/16 §3.3）。
 * 第 4 回合起为 10（实战意义即「不再节流」）。
 */
export const MAX_COST_CURVE = [1, 3, 5, 10] as const;

/** B2 布局：随从区 1·2·3，故场上随从上限 3。 */
export const BOARD_SLOTS = 3;

/**
 * 初始血量 —— 8（docs/16 §1，ADR-0024）。9 血与 15 血版的模拟结论见 docs/13~15。
 */
export const INITIAL_HEALTH = 8;

/** 起手：先手 5 张（docs/16 §1）。 */
export const INITIAL_HAND = 5;
/** 起手：后手 6 张（docs/16 §1，ADR-0024 对先手不抽牌的补偿）。 */
export const SECOND_PLAYER_HAND = 6;

/** A9 补充 1：每回合抽牌阶段抽 2 张。 */
export const DRAW_PER_TURN = 2;

/**
 * 充能阶段强制收入 —— 每次进入己方充能阶段，从卡组顶取 2 张置入费用区
 * （docs/16 §2.1 / §3.2，ADR-0024）。这是「降低空过」的基础，不是可选动作。
 */
export const COST_INCOME_PER_TURN = 2;

/**
 * 随从减费（docs/16 §4）：实际支付 = max(0, 卡面费用 − 1)。
 * 只作用于随从；法术与设置法术按卡面值（§4.1）。
 */
export const MINION_COST_DISCOUNT = 1;

/**
 * 指挥官攻击的**基础**伤害（docs/16 §6.1）—— 不比较力量、不受前排限制。
 *
 * ⚠️ 它只是基数：实际伤害 = `COMMANDER_ATTACK_DAMAGE + commanderDamageBonus`
 * （H34 / ADR-0028，Era 2026-10-19 确认「指挥官的 1 点可以被伤害加成类效果提升」）。
 * 随从实例的 `tempDamage` 不转移给指挥官；固定直伤（星陨）不吃加成。
 */
export const COMMANDER_ATTACK_DAMAGE = 1;

/**
 * 指挥官技能费用 —— **固定 2 费**（D-229 撤销 D-228 的「3 − 档位」）。
 *
 * docs/12 §2.1 / §4.1 的卡面原文即【2】；D-228 曾改为随力量档位递减，
 * D-229 明确「撤销通用成长，各指挥官用专属资源」，于是回到固定值。
 */
export const COMMANDER_SKILL_COST = 2;

/**
 * 霜痕档位（docs/16 §6.3.3 / D-229）：霜痕 ≥ 3 → 抽 1；≥ 6 → 冻 2；≥ 9 → 冻 2 + 抽 1。
 * 写成升序阈值，档位判定只需比较最大满足项。
 */
export const FROST_MARK_TIERS = [3, 6, 9] as const;

/**
 * 星轨档位（docs/17 §2.2 / D-230）：星轨 ≥ 3 → 展示 3 张；≥ 6 → 展示 4 张。
 * 基础展示 2 张（0–2 层）。
 */
export const STAR_TRACK_TIERS = [3, 6] as const;
/** 星轨 0–2 层时的基础展示张数。 */
export const STAR_TRACK_BASE_REVEAL = 2;

/**
 * 打脸伤害分档（docs/16 §5.5）：力量 1–3 → 1，4–6 → 2，7+ → 3。
 * 卡面写了 `damage` 的以卡面为准（例外覆盖）。
 */
export const DAMAGE_TIER_MAX_LOW = 3;
export const DAMAGE_TIER_MAX_MID = 6;

/** 40 轮未分胜负判和（docs/16 §7）；全局回合 = 轮次 × 2。 */
export const TURN_LIMIT_ROUNDS = 40;
export const TURN_LIMIT = TURN_LIMIT_ROUNDS * 2;

/**
 * A6-5 / A10-4（2026-10-13 Era 确认）：卡组 31 张 = 主卡组 30 + 指挥官 1。
 * 指挥官开局直接进指挥官区，**不进主卡组、不参与洗牌与抽牌**。
 */
export const MAIN_DECK_SIZE = 30;
export const COMMANDER_COUNT = 1;
export const DECK_SIZE = MAIN_DECK_SIZE + COMMANDER_COUNT; // 31

/** A6-5：同名卡上限 3 张；指挥官有且仅有 1 张。 */
export const MAX_COPIES = 3;

/** A5-2：最高费用初始为 1。 */
export const INITIAL_MAX_COST = 1;

/** A10-3 + docs/16 §1：先攻方第一回合**抽 0 张**（ADR-0024，原为 1 张）。 */
export const FIRST_TURN_DRAW = 0;

/** A2-4：先后手由 1d6 掷骰决定，较大者先攻。 */
export const SEQUENCE_DIE = 6;

/**
 * X-5（Era 2026-10-13）：**卡上未写伤害值时，伤害值默认为 1**。
 *
 * 此前按「缺失时用 `power` 兜底」（假设 H13），Era 已给出确定值 —— 与 `power` 无关。
 */
export const DEFAULT_DAMAGE = 1;

/**
 * X-7（Era 2026-10-13）：**指挥官力量值初始取曲线第 0 档**。
 *
 * 「初始 0 然后每个充能阶段成长」—— 故开局（尚未经历任何充能阶段）时索引为 0，
 * 第一次充能阶段后变为 1。写成常量是因为它同时被 `createInitialState` 与
 * `growCommander` 的封顶逻辑依赖，散落成字面量后改一处会漏另一处。
 */
export const INITIAL_COMMANDER_POWER_INDEX = 0;

/**
 * A7：关键词。**现仅 `taunt` 一个**，后续由 Era 补充。
 * 单独成常量而非在各规则文件里写字面量 —— 关键词表是全表最容易变动的一处。
 */
export const KEYWORD_TAUNT = 'taunt';

/** 规则拒绝码 —— 与房间错误码（`ROOM_ERRORS`）分属两层，不得混用。 */
export const RULE_ERRORS = {
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  NOT_STARTED: 'NOT_STARTED',
  ALREADY_STARTED: 'ALREADY_STARTED',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  WRONG_PHASE: 'WRONG_PHASE',
  CARD_NOT_FOUND: 'CARD_NOT_FOUND',
  CARD_NOT_IN_ZONE: 'CARD_NOT_IN_ZONE',
  INSUFFICIENT_COST: 'INSUFFICIENT_COST',
  BOARD_FULL: 'BOARD_FULL',
  ALREADY_ATTACKED: 'ALREADY_ATTACKED',
  /** 单位处于休眠态，本回合已攻击过（A9-2）。 */
  UNIT_ASLEEP: 'UNIT_ASLEEP',
  /** A10-3：先攻方第一回合不可攻击。 */
  CANNOT_ATTACK: 'CANNOT_ATTACK',
  INVALID_TARGET: 'INVALID_TARGET',
  MUST_ATTACK_TAUNT: 'MUST_ATTACK_TAUNT',
  /** docs/16 §5.2 前排：对方随从区有随从时不能打脸。 */
  FRONT_LINE: 'FRONT_LINE',
  /** docs/16 §5.5：攻击者力量低于敌方指挥官当前力量，不能宣告打脸。 */
  COMMANDER_POWER_TOO_LOW: 'COMMANDER_POWER_TOO_LOW',
  /** docs/16 §6.1：指挥官本回合已经攻击过（每战斗阶段一次）。 */
  COMMANDER_ATTACK_USED: 'COMMANDER_ATTACK_USED',
  /** docs/16 §3.3：本回合已消耗张数触及 maxCost 上限。 */
  MAX_COST_EXCEEDED: 'MAX_COST_EXCEEDED',
  GAME_OVER: 'GAME_OVER',
  MULLIGAN_DONE: 'MULLIGAN_DONE',
  /*
   * D-267 删掉了 `MULLIGAN_EXPIRED` —— 换牌窗口改由服务端计时器裁决后，
   * 规则层不再产生「时间窗已过」这个拒绝：到点时计时器已经替未确认方提交了「跳过」，
   * 阶段随之关闭，此后换牌的拒绝原因是 `WRONG_PHASE`（「当前已不是开局换牌阶段」）。
   * 留一个永不产生的错误码只会让客户端映射表里多一条死文案。
   */
  /** 本抽牌阶段已抽过牌（抽牌为手动点击卡组，Era 2026-10-18）。 */
  DRAW_DONE: 'DRAW_DONE',
  /** 卡组构成不合法（主卡组张数、同名上限、指挥官缺失或类型错）。 */
  INVALID_DECK: 'INVALID_DECK',
  /** 有待定选择挂起，须先由该玩家回答（ADR-0023 §2 全局守卫）。 */
  PENDING_CHOICE: 'PENDING_CHOICE',
  /** 效果当前不可发动（次数已用 / 条件不满足 / 支付不足）。 */
  EFFECT_UNAVAILABLE: 'EFFECT_UNAVAILABLE',
  /** 回答的不是待定选择的合法选项。 */
  INVALID_CHOICE: 'INVALID_CHOICE',
  /** 支付时自选的费用卡不合法（张数不对 / 不在费用区 / 重复）—— D-257。 */
  INVALID_COST_PICK: 'INVALID_COST_PICK',
  /** 召唤位置不合法（越界 / 非整数 / 给非随从指定位置）—— D-257。 */
  INVALID_SLOT: 'INVALID_SLOT',
} as const;

export type RuleErrorCode = (typeof RULE_ERRORS)[keyof typeof RULE_ERRORS];
