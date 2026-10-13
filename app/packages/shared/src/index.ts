export type {
  PlayerId,
  IntentActor,
  Intent,
  GameEvent,
  GameState,
  Rejection,
  Result,
  RuleContext,
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
