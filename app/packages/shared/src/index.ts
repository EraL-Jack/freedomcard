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
  DRAW_PER_TURN,
  MAIN_DECK_SIZE,
  COMMANDER_COUNT,
  DECK_SIZE,
  MAX_COPIES,
  INITIAL_MAX_COST,
  FIRST_TURN_DRAW,
  SEQUENCE_DIE,
  RULE_ERRORS,
} from './constants.js';
export type { RuleErrorCode } from './constants.js';
