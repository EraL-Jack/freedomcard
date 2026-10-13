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
  roomState: 'room:state',
  gameIntent: 'game:intent',
  gameEvents: 'game:events',
  gameSnapshot: 'game:snapshot',
} as const;

/**
 * 传输层超时常量（ADR-0010）。**禁止混用**：
 * - `RECONNECT_GRACE_MS`：断线后席位保留时长
 * - `TURN_TIMEOUT_MS`：回合内无操作，服务端自动结束回合的时长
 */
export const RECONNECT_GRACE_MS = 60_000;
export const TURN_TIMEOUT_MS = 30_000;

/** 房间错误码 —— 传输层统一口径，客户端据此提示。 */
export const ROOM_ERRORS = {
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_ENDED: 'ROOM_ENDED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  GRACE_EXPIRED: 'GRACE_EXPIRED',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
} as const;

export type RoomErrorCode = (typeof ROOM_ERRORS)[keyof typeof ROOM_ERRORS];

/* ------------------------------------------------------------------ *
 * 玩法常量 —— 全部照抄 `docs/06` A 组的 Era 输入，不得自行推算。
 * 每条都注明来源，便于日后核对。
 * ------------------------------------------------------------------ */

/** A5-2：最高费用增长序列，第 4 回合达到上限。写成离散表而非公式 —— Era 给的是四个值。 */
export const MAX_COST_CURVE = [1, 3, 5, 10] as const;

/** B2 布局：随从区 1·2·3，故场上随从上限 3。 */
export const BOARD_SLOTS = 3;

/** A10-2：初始血量 15。 */
export const INITIAL_HEALTH = 15;

/** A10-1：起手 5 张。 */
export const INITIAL_HAND = 5;

/** A9 补充 1：每回合抽排阶段抽 2 张。 */
export const DRAW_PER_TURN = 2;

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

/** A10-3：先攻方第一回合仅抽 1 张，且不可攻击。 */
export const FIRST_TURN_DRAW = 1;

/** A2-4：先后手由 1d6 掷骰决定，较大者先攻。 */
export const SEQUENCE_DIE = 6;

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
  INVALID_TARGET: 'INVALID_TARGET',
  MUST_ATTACK_TAUNT: 'MUST_ATTACK_TAUNT',
  GAME_OVER: 'GAME_OVER',
  MULLIGAN_DONE: 'MULLIGAN_DONE',
} as const;

export type RuleErrorCode = (typeof RULE_ERRORS)[keyof typeof RULE_ERRORS];
