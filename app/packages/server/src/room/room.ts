import type { Faction, MatchFormat, PlayerId } from '@app/shared';
import { RECONNECT_GRACE_MS, ROOM_ERRORS } from '@app/shared/constants';

import { validateDeckList } from '../deck-pool.js';

import type { Clock, IdGen, Outcome, Room, Seat } from './types.js';

/** 座位轮换的默认阵营 —— 未显式选择时，让相邻两席尽量不同（star 留给第三席）。 */
const DEFAULT_FACTIONS: readonly Faction[] = ['blade', 'frost', 'star'];

/** BO3 拿满几胜算赢下系列赛。 */
const WINS_TO_TAKE_SERIES = 2;

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

  /**
   * 归一自建卡组（D-141）。
   *
   * - 未传 / 空数组 → `{ ok: true }`（无 `deck`，用阵营默认）
   * - 非法 → `{ ok: false, message }`（人话原因）
   *
   * 入站 schema 只保证「是字符串数组且 ≤30 张」，张数与同名上限在这里查。
   */
  private checkDeck(
    deck?: readonly string[],
  ): { ok: true; deck?: readonly string[] } | { ok: false; message: string } {
    if (!deck || deck.length === 0) return { ok: true };
    const reason = validateDeckList(deck);
    if (reason) return { ok: false, message: reason };
    return { ok: true, deck: [...deck] };
  }

  create(input: {
    nickname: string;
    capacity: number;
    format?: MatchFormat;
    faction?: Faction;
    /** 自建主卡组（D-141）；缺省或空数组 = 用阵营默认。 */
    deck?: readonly string[];
  }): Outcome<JoinInfo> {
    if (input.capacity < 1) {
      return { ok: false, error: ROOM_ERRORS.ROOM_NOT_FOUND, message: '房间容量必须 >= 1' };
    }
    const deckCheck = this.checkDeck(input.deck);
    if (!deckCheck.ok) {
      return { ok: false, error: ROOM_ERRORS.INVALID_DECK, message: deckCheck.message };
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
      ready: false,
      faction: input.faction ?? DEFAULT_FACTIONS[0]!,
      ...(deckCheck.deck ? { deck: deckCheck.deck } : {}),
    };
    const room: Room = {
      id: this.ids.id(),
      code,
      phase: 'lobby',
      capacity: input.capacity,
      hostId: playerId,
      seats: Array.from({ length: input.capacity }, (_, i) => (i === 0 ? seat : null)),
      createdAt: this.clock.now(),
      // D-132：赛制由建房方选择，缺省 BO1（老客户端不带该字段）。
      format: input.format ?? 'bo1',
      wins: { [playerId]: 0 },
      gameNo: 0,
      awaitingNext: false,
      seriesWinner: null,
      firstPlayers: [],
      lastLoser: null,
    };
    this.rooms.set(room.id, room);
    this.byCode.set(code, room.id);
    this.byPlayer.set(playerId, { roomId: room.id, token });
    return { ok: true, value: { room, seat } };
  }

  join(input: {
    code: string;
    nickname: string;
    faction?: Faction;
    /** 自建主卡组（D-141）；缺省或空数组 = 用阵营默认。 */
    deck?: readonly string[];
  }): Outcome<JoinInfo> {
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
    const deckCheck = this.checkDeck(input.deck);
    if (!deckCheck.ok) {
      return { ok: false, error: ROOM_ERRORS.INVALID_DECK, message: deckCheck.message };
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
      ready: false,
      faction: input.faction ?? DEFAULT_FACTIONS[free % DEFAULT_FACTIONS.length]!,
      ...(deckCheck.deck ? { deck: deckCheck.deck } : {}),
    };
    room.seats[free] = seat;
    room.wins[playerId] = 0;
    this.byPlayer.set(playerId, { roomId: room.id, token });
    return { ok: true, value: { room, seat } };
  }

  /**
   * 换卡组（D-141）—— 准备页用。
   *
   * 只在**未开局**（`phase === 'lobby'`）时允许；开局后锁定（`DECK_LOCKED`）。
   * 空数组 = 回到阵营默认卡组。指挥官不随之改变（仍由阵营决定）。
   */
  /**
   * 换卡组（D-141）—— 准备页用。
   *
   * 只在**未开局**（`phase === 'lobby'`）时允许；开局后锁定（`DECK_LOCKED`）。
   * 空数组 = 回到阵营默认卡组。指挥官不随之改变（仍由阵营决定）。
   *
   * **BO3 局间也不能换**（H37 / Era 2026-10-20：「不允许更换卡组」）。
   * 这一条单独判 `awaitingNext`，不只依赖 `phase` —— 局间房间仍是 `playing`，
   * 但若将来为了让玩家点「准备」而把 `phase` 改回 `lobby`，只判 `phase` 就会**静默放开**局间换卡组。
   */
  setDeck(roomId: string, playerId: PlayerId, deck: readonly string[]): Outcome<Room> {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, error: ROOM_ERRORS.ROOM_NOT_FOUND, message: '房间不存在' };
    }
    if (room.awaitingNext) {
      return {
        ok: false,
        error: ROOM_ERRORS.DECK_LOCKED,
        message: '系列赛进行中，两局之间不能更换卡组',
      };
    }
    if (room.phase !== 'lobby') {
      return { ok: false, error: ROOM_ERRORS.DECK_LOCKED, message: '对局已开始，不能再换卡组' };
    }
    const seat = room.seats.find((s) => s?.playerId === playerId) ?? null;
    if (!seat) {
      return { ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '你不在这个房间' };
    }
    const deckCheck = this.checkDeck(deck);
    if (!deckCheck.ok) {
      return { ok: false, error: ROOM_ERRORS.INVALID_DECK, message: deckCheck.message };
    }
    if (deckCheck.deck) seat.deck = deckCheck.deck;
    else delete seat.deck;
    return { ok: true, value: room };
  }

  /**
   * 记录一小局的结果（D-132）。
   *
   * - BO1：直接结束房间；
   * - BO3：有人拿到 2 胜 → 结束；否则进入「等待下一小局」，由房主发起。
   * - 平局（40 轮判和）不计分，但同样消耗一局。
   */
  recordGameResult(roomId: string, winner: PlayerId | null): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.gameNo += 1;
    if (winner) room.wins[winner] = (room.wins[winner] ?? 0) + 1;
    // H33（D-145）：第 3 小局由上一小局的败者先攻 —— 判和时无败者，置 null 回落掷骰。
    room.lastLoser = winner
      ? (room.seats.find((s) => s && s.playerId !== winner)?.playerId ?? null)
      : null;

    if (room.format === 'bo1') {
      room.phase = 'ended';
      room.seriesWinner = winner;
      room.awaitingNext = false;
      return room;
    }

    const leader = Object.entries(room.wins).find(([, w]) => w >= WINS_TO_TAKE_SERIES);
    if (leader) {
      room.phase = 'ended';
      room.seriesWinner = leader[0];
      room.awaitingNext = false;
    } else {
      // 系列赛继续：房间留在 playing（只是这一小局结束了），由房主发起下一局。
      room.phase = 'playing';
      room.awaitingNext = true;
    }
    return room;
  }

  /** 房主开始下一小局 —— 清掉等待标记。 */
  markNextGameStarted(roomId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.awaitingNext = false;
    return room;
  }

  /**
   * 下一小局的先手人选（docs/16 §1.3 / H33）。
   *
   * - 第 2 小局：由第 1 小局的后手先攻 —— 「双方各先手一次」；
   * - 第 3 小局：由**上一小局的败者**先攻（Era 2026-10-19 拍板，取代原先的「重新掷骰」）。
   *   判和时没有败者，返回 `null`，由调用方回落到掷骰。
   */
  nextFirstPlayer(roomId: string): PlayerId | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.gameNo === 1) {
      const prev = room.firstPlayers[0];
      if (!prev) return null;
      return room.seats.find((s) => s && s.playerId !== prev)?.playerId ?? null;
    }
    return room.lastLoser;
  }

  /**
   * 系列赛判负（对局中离场 / 认输后不再继续）。
   *
   * 与 `recordGameResult` 分开：离场不是「打完一局」，不该给小局计数 +1，
   * 但它必须结束整个系列赛，否则留下的人会卡在「等待下一局」。
   */
  forfeitSeries(roomId: string, loser: PlayerId): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.phase = 'ended';
    room.awaitingNext = false;
    room.seriesWinner = room.seats.find((s) => s && s.playerId !== loser)?.playerId ?? null;
    return room;
  }

  /**
   * 准备 —— B1 补充 3「双方加入并准备后即开始游戏」+ ADR-0019。
   *
   * 返回 `allReady` 表示**本次操作后**是否「满员且全员就绪」；由会话层据此决定是否开局。
   * 重复设 true 是幂等的 —— 两名玩家几乎同时点准备是常态，幂等放在这里比放在调用方可靠。
   *
   * 房间已不在 `lobby` 时返回 `allReady: false`，由会话层保证不会二次开局。
   */
  setReady(playerId: PlayerId): Outcome<{ room: Room; allReady: boolean }> {
    const found = this.locate(playerId);
    if (!found) return { ok: false, error: ROOM_ERRORS.NOT_IN_ROOM, message: '不在房间内' };
    const { room, seat } = found;
    if (room.phase !== 'lobby') return { ok: true, value: { room, allReady: false } };
    seat.ready = true;
    const allReady = room.seats.every((s) => s !== null && s.ready);
    return { ok: true, value: { room, allReady } };
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
      // D-132：赛制与系列赛比分 —— 客户端据此显示「第 2 局 1:0」与「开始下一局」。
      format: room.format,
      gameNo: room.gameNo,
      wins: { ...room.wins },
      awaitingNext: room.awaitingNext,
      seriesWinner: room.seriesWinner,
      firstPlayers: [...room.firstPlayers],
      seats: room.seats.map((s) =>
        s
          ? {
              seat: s.seat,
              playerId: s.playerId,
              nickname: s.nickname,
              connected: s.connected,
              // ADR-0019：准备状态属于房间层事实，不含任何玩法信息。
              ready: s.ready,
              faction: s.faction,
              // D-141：只下发「是否用了自建卡组」，30 个 defId 留在服务端。
              deckSize: s.deck?.length ?? null,
            }
          : null,
      ),
    };
  }
}
