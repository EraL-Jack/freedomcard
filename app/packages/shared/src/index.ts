export type {
  PlayerId,
  IntentActor,
  Intent,
  GameEvent,
  GameState,
  Rejection,
  Result,
  RuleContext,
  CardType,
  Zone,
  Phase,
  CardDef,
  CardInstance,
  PlayerState,
  TurnTrigger,
  PendingChoice,
} from './types.js';

export {
  PlayerIdSchema,
  IntentSchema,
  EchoSchema,
  HealthSchema,
  RoomCreateSchema,
  RoomJoinSchema,
  RoomReconnectSchema,
} from './schema.js';
export type { EchoPayload } from './schema.js';

export { SOCKET_EVENTS, RECONNECT_GRACE_MS, TURN_TIMEOUT_MS, ROOM_ERRORS } from './constants.js';
export type { RoomErrorCode } from './constants.js';

export {
  MAX_COST_CURVE,
  BOARD_SLOTS,
  INITIAL_HEALTH,
  INITIAL_HAND,
  SECOND_PLAYER_HAND,
  DRAW_PER_TURN,
  COST_INCOME_PER_TURN,
  MINION_COST_DISCOUNT,
  COMMANDER_ATTACK_DAMAGE,
  DAMAGE_TIER_MAX_LOW,
  DAMAGE_TIER_MAX_MID,
  TURN_LIMIT_ROUNDS,
  TURN_LIMIT,
  MAIN_DECK_SIZE,
  COMMANDER_COUNT,
  DECK_SIZE,
  MAX_COPIES,
  INITIAL_MAX_COST,
  FIRST_TURN_DRAW,
  SEQUENCE_DIE,
  DEFAULT_DAMAGE,
  INITIAL_COMMANDER_POWER_INDEX,
  KEYWORD_TAUNT,
  MULLIGAN_WINDOW_MS,
  RULE_ERRORS,
} from './constants.js';
export type { RuleErrorCode } from './constants.js';

/**
 * 卡池 —— 唯一定义在 `shared/src/cards.ts`（ADR-0020）。
 *
 * ⚠️ 客户端必须走**子路径** `@app/shared/cards`，不要从本文件（`.`）导入 ——
 * 本文件会经 `schema.js` 拉入 zod，实测首屏 +24 kB gzip。
 */
export { CARD_POOL, PLACEHOLDER_CARD_IDS, isBladeCard, isFrostCard, ACTIVATABLE_EFFECTS } from './cards.js';
