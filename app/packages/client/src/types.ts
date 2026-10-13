import type { GameState, RoomErrorCode } from '@app/shared';

/**
 * 客户端视图类型 —— 与服务端 `RoomManager.publicView` 的返回结构**逐字段对应**。
 *
 * 单独成文件是因为三个界面（主界面 / 对战桌 / 卡组编辑）都要引用，
 * 且它必须与服务端视图保持同步：服务端改了字段，这里要跟着改。
 */

export interface RoomSeatView {
  seat: number;
  playerId: string;
  nickname: string;
  connected: boolean;
  /** ADR-0019：准备状态（房间层事实，非玩法状态）。 */
  ready: boolean;
}

export interface RoomView {
  id: string;
  code: string;
  phase: string;
  capacity: number;
  hostId: string;
  seats: (RoomSeatView | null)[];
}

/** 对局快照 —— 客户端 `reduce` 的**起点**，没有它增量事件无从应用。 */
export interface SnapshotView {
  state: GameState;
  hash: string;
  serverSeq: number;
  lastSeqByPlayer: Record<string, number>;
}

/**
 * 服务端回包。
 *
 * ⚠️ 字段全可选是刻意的：各事件的 ack 形状并不统一（建房带 token，
 * Intent 只带 ok/out），统一成一个宽松类型比写一堆联合更好维护。
 */
export interface Ack {
  ok?: boolean;
  error?: string;
  message?: string;
  room?: RoomView;
  playerId?: string;
  token?: string;
  seat?: number;
  snapshot?: SnapshotView;
  out?: { kind: string; error?: { code: string; message: string } };
}

/** 房间错误提示文案 —— 传输层错误码 → 人话。 */
export function roomErrorText(code: RoomErrorCode | string | undefined): string {
  switch (code) {
    case 'ROOM_NOT_FOUND':
      return '房间不存在';
    case 'ROOM_FULL':
      return '房间已满';
    case 'ROOM_ENDED':
      return '对局已结束';
    case 'INVALID_TOKEN':
      return '重连凭据无效';
    case 'GRACE_EXPIRED':
      return '超出席位保留时长';
    case 'NOT_IN_ROOM':
      return '不在房间内';
    default:
      return code ?? '未知错误';
  }
}
