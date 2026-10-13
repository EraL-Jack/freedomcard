/**
 * 协议与状态的基础类型。
 *
 * ⚠️ 玩法相关的字段（卡牌、费用、血量、回合阶段等）**一律不在本文件定义**。
 * 它们完全由 `docs/06-规则与界面输入表.md` A 组的输入决定；A 组未填之前，
 * 任何业务字段都不得出现在类型里 —— 否则等于替 Era 发明玩法。
 * 本文件只定义「与玩法无关、任何规则都绕不开」的骨架。
 */

export type PlayerId = string;

/** Intent 的发起方。`system` 用于服务端构造的行为（如回合超时自动结束回合）。 */
export type IntentActor = 'player' | 'system';

/**
 * 玩家 / 系统发起的一次原子操作。
 * `seq` 由客户端按 playerId 单调递增，用于传输层去重（见 ADR-0011：去重归服务端 Room 层）。
 */
export interface Intent {
  /** 操作类型。具体取值由 A 组输入决定，当前未定义任何字面量。 */
  type: string;
  actor: IntentActor;
  playerId: PlayerId;
  seq: number;
  /** 仅系统 Intent 携带，说明触发原因（如 `'timeout'`）。 */
  reason?: string;
}

/** 规则引擎产出的原子状态变更。 */
export interface GameEvent {
  type: string;
  /** 服务端时间戳 —— 全局唯一时间来源；core 内禁止读时钟。 */
  at: number;
}

/**
 * 对局状态。
 *
 * 只含一个字段：`rngCursor`（ADR-0010）。随机游标必须入 state，否则洗牌等
 * 随机行为无法在回放中复现。其余业务字段待 A 组输入后追加。
 */
export interface GameState {
  rngCursor: number;
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
}
