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

/** 卡牌类型 —— `docs/06` A6-1。 */
export type CardType = 'commander' | 'minion' | 'spell' | 'continuous';

/**
 * 区域 —— ADR-0012，与 `docs/06` B2 布局逐项对应。
 * **没有独立的 `charge`（充能区）**：Era 于 2026-10-13 确认 X-2 中的「充能区」即 `cost`。
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
}

export interface PlayerState {
  id: PlayerId;
  /** 血量 —— `docs/06` A10-2 初始 15；归零判负（A3-1）。 */
  health: number;
  /** 最高费用 —— A5-2 曲线 1→3→5→10，第 4 回合达上限。 */
  maxCost: number;
  zones: Record<Zone, CardInstance[]>;
  /** X-1：指挥官在第一个充能阶段揭示后直接置入指挥官区。 */
  commanderRevealed: boolean;
  /** 起手换牌只允许一次（A10-1）。 */
  mulliganDone: boolean;
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
  /** 回合数，从 1 开始。 */
  turn: number;
  /** 是否已开局（完成洗牌、发牌、掷骰）。 */
  started: boolean;
  /** 胜负：血空（A3-1）或认输（A3-4）后写入；平局按 A3-3 不存在。 */
  winner: PlayerId | null;
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
