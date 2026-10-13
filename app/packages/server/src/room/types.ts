import type { PlayerId } from '@app/shared';
import type { RoomErrorCode } from '@app/shared/constants';

/**
 * 房间与席位 —— **只描述传输层事实**，不含任何玩法字段。
 *
 * 房间容量、胜负、回合等一概不在此定义：容量由建房方传入（Era 未定人数，不预设 2），
 * 玩法字段等 `docs/06` A 组输入后进入 `GameState`。
 */

export type RoomPhase = 'lobby' | 'playing' | 'ended';

/** 一个席位。`null` 表示空位。 */
export interface Seat {
  seat: number;
  playerId: PlayerId;
  nickname: string;
  /** 重连凭据：断线后凭此恢复席位。 */
  token: string;
  connected: boolean;
  /** 服务端已处理的最大 seq —— 重连时下发给客户端，客户端从 `lastSeq + 1` 续发。 */
  lastSeq: number;
  disconnectedAt: number | null;
}

export interface Room {
  id: string;
  code: string;
  phase: RoomPhase;
  capacity: number;
  hostId: PlayerId;
  seats: (Seat | null)[];
  createdAt: number;
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: RoomErrorCode; message: string };

/** 注入时钟 —— 让全部超时逻辑可单测（core 内禁止读时钟，会话层可以，但要可注入）。 */
export interface Clock {
  now(): number;
}

/** 注入 ID 生成器 —— 房间码 / playerId / token，便于测试固定值。 */
export interface IdGen {
  id(): string;
  token(): string;
  code(): string;
}
