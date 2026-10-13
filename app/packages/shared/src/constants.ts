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
