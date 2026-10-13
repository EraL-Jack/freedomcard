import { RECONNECT_GRACE_MS, ROOM_ERRORS } from '@app/shared/constants';
import type { PlayerId } from '@app/shared';

import type { Clock, IdGen, Outcome, Room, Seat } from './types.js';

export interface JoinInfo {
  room: Room;
  seat: Seat;
}

export interface ReconnectInfo extends JoinInfo {
  /** 客户端须从 `lastSeq + 1` 续发 Intent，禁止本地计数归零重来。 */
  lastSeq: number;
}

export interface RoomManagerDeps {
  clock: Clock;
  ids: IdGen;
  /** 席位保留时长，默认 `RECONNECT_GRACE_MS`。 */
  graceMs?: number;
}

/**
 * 房间与席位管理（内存实现，Demo 阶段够用；后续接 Redis 时替换本类即可）。
 *
 * 只处理传输层事实：建房、加入、断线保留、重连、释放。**不含任何玩法逻辑**，
 * 也不预设房间容量 —— 容量由建房方传入。
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly byCode = new Map<string, string>();
  private readonly byPlayer = new Map<PlayerId, { roomId: string; token: string }>();
  private readonly clock: Clock;
  private readonly ids: IdGen;
  private readonly graceMs: number;

  constructor(deps: RoomManagerDeps) {
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.graceMs = deps.graceMs ?? RECONNECT_GRACE_MS;
  }

  create(input: { nickname: string; capacity: number }): Outcome<JoinInfo> {
    if (input.capacity < 1) {
      return { ok: false, error: ROOM_ERRORS.ROOM_NOT_FOUND, message: '房间容量必须 >= 1' };
    }
    const playerId = this.ids.id();
    const token = this.ids.token();
    let code = this.ids.code();
    while (this.byCode.has(code)) code = this.ids.code();

    const seat: Seat = {
      seat: 0,
      playerId,
      nickname: input.nickname,
      token,
      connected: true,
      lastSeq: 0,
      disconnectedAt: null,
    };
    const room: Room = {
      id: this.ids.id(),
      code,
      phase: 'lobby',
      capacity: input.capacity,
      hostId: playerId,
      seats: Array.from({ length: input.capacity }, (_, i) => (i === 0 ? seat : null)),
      createdAt: this.clock.now(),
    };
    this.rooms.set(room.id, room);
    this.byCode.set(code, room.id);
    this.byPlayer.set(playerId, { roomId: room.id, token });
    return { ok: true, value: { room, seat } };
  }

  join(input: { code: string; nickname: string }): Outcome<JoinInfo> {
    const roomId = this.byCode.get(input.code);
    if (!roomId) {
      return { ok: false, error: ROOM_ERRORS.ROOM_NOT_FOUND, message: '房间不存在' };
    }
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, error: ROOM_ERRORS.ROOM_NOT_FOUND, message: '房间不存在' };
    }
    if (room.phase === 'ended') {
      return { ok: false, error: ROOM_ERRORS.ROOM_ENDED, message: '对局已结束' };
    }
    const free = room.seats.findIndex((s) => s === null);
    if (free < 0) {
      return { ok: false, error: ROOM_ERRORS.ROOM_FULL, message: '房间已满' };
    }
    const playerId = this.ids.id();
    const token = this.ids.token();
    const seat: Seat = {
      seat: free,
      playerId,
      nickname: input.nickname,
      token,
      connected: true,
      lastSeq: 0,
      disconnectedAt: null,
    };
    room.seats[free] = seat;
    this.byPlayer.set(playerId, { roomId: room.id, token });
    return { ok: true, value: { room, seat } };
  }

  /** 标记断线：席位不释放，进入保留窗口。 */
  markDisconnected(playerId: PlayerId): Outcome<{ room: Room }> {
    const found = this.locate(playerId);
    if (!found) return { ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '不在房间内' };
    const { room, seat } = found;
    seat.connected = false;
    seat.disconnectedAt = this.clock.now();
    return { ok: true, value: { room } };
  }

  reconnect(input: { playerId: PlayerId; token: string }): Outcome<ReconnectInfo> {
    const binding = this.byPlayer.get(input.playerId);
    if (!binding || binding.token !== input.token) {
      return { ok: false, error: ROOM_ERRORS.INVALID_TOKEN, message: '重连凭据无效' };
    }
    const room = this.rooms.get(binding.roomId);
    if (!room) return { ok: false, error: ROOM_ERRORS.ROOM_NOT_FOUND, message: '房间不存在' };

    const seat = room.seats.find((s) => s?.playerId === input.playerId) ?? null;
    if (!seat) return { ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '席位已释放' };

    if (seat.disconnectedAt !== null) {
      const elapsed = this.clock.now() - seat.disconnectedAt;
      if (elapsed > this.graceMs) {
        return { ok: false, error: ROOM_ERRORS.GRACE_EXPIRED, message: '超出席位保留时长' };
      }
    }
    seat.connected = true;
    seat.disconnectedAt = null;
    return { ok: true, value: { room, seat, lastSeq: seat.lastSeq } };
  }

  /** 主动离开：立即释放席位。房主离开则把房主移交给下一个在场玩家。 */
  leave(playerId: PlayerId): Outcome<{ room: Room | null }> {
    const binding = this.byPlayer.get(playerId);
    if (!binding) return { ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '不在房间内' };
    const room = this.rooms.get(binding.roomId);
    if (!room) {
      this.byPlayer.delete(playerId);
      return { ok: true, value: { room: null } };
    }
    const idx = room.seats.findIndex((s) => s?.playerId === playerId);
    if (idx >= 0) room.seats[idx] = null;
    this.byPlayer.delete(playerId);

    if (room.hostId === playerId) {
      const next = room.seats.find((s) => s !== null);
      if (next) room.hostId = next.playerId;
    }
    if (room.seats.every((s) => s === null)) {
      this.rooms.delete(room.id);
      this.byCode.delete(room.code);
      return { ok: true, value: { room: null } };
    }
    return { ok: true, value: { room } };
  }

  /**
   * 释放超出保留窗口的断线席位；房间空了则销毁。
   * 由调用方定时驱动（会话层持有定时器），不在这里自建定时器 —— 便于单测。
   */
  prune(now: number = this.clock.now()): PlayerId[] {
    const freed: PlayerId[] = [];
    for (const room of [...this.rooms.values()]) {
      for (let i = 0; i < room.seats.length; i++) {
        const seat = room.seats[i];
        if (!seat || seat.connected || seat.disconnectedAt === null) continue;
        if (now - seat.disconnectedAt <= this.graceMs) continue;
        room.seats[i] = null;
        this.byPlayer.delete(seat.playerId);
        freed.push(seat.playerId);
      }
      if (room.seats.every((s) => s === null)) {
        this.rooms.delete(room.id);
        this.byCode.delete(room.code);
      }
    }
    return freed;
  }

  locate(playerId: PlayerId): { room: Room; seat: Seat } | null {
    const binding = this.byPlayer.get(playerId);
    if (!binding) return null;
    const room = this.rooms.get(binding.roomId);
    if (!room) return null;
    const seat = room.seats.find((s) => s?.playerId === playerId) ?? null;
    return seat ? { room, seat } : null;
  }

  getRoom(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  getRoomByCode(code: string): Room | undefined {
    const roomId = this.byCode.get(code);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  /** 客户端可见的房间视图 —— 不泄漏 token。 */
  publicView(room: Room) {
    return {
      id: room.id,
      code: room.code,
      phase: room.phase,
      capacity: room.capacity,
      hostId: room.hostId,
      seats: room.seats.map((s) =>
        s ? { seat: s.seat, playerId: s.playerId, nickname: s.nickname, connected: s.connected } : null,
      ),
    };
  }
}
