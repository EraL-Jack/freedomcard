import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as core from '@app/core';
import { SOCKET_EVENTS, type GameEvent, type GameState, type Intent, type PlayerId } from '@app/shared';

import { describeEvent } from './log.js';
import { socket } from './socket.js';
import type { Ack, RoomView } from './types.js';

/**
 * 会话 hook —— 客户端**唯一**的服务端交互入口。
 *
 * 纪律（ADR-0002 / ADR-0003）：
 *  1. **界面只发 Intent**，不做任何规则计算；
 *  2. **状态只从事件流演进** —— 服务端广播的事件逐个 `reduce`，
 *     禁止本地推算或乐观更新（否则 `stateHash` 就失去了唯一仲裁者的地位）；
 *  3. 起点状态来自服务端下发的**快照**，之后才是增量事件。
 */

export type LinkState = 'connecting' | 'online' | 'offline';

export interface LogEntry {
  id: number;
  at: number;
  text: string;
}

/** 服务端 `game:events` 广播载荷（accepted / rejected / dropped 三态）。 */
interface EventsOut {
  kind: string;
  events?: GameEvent[];
  hash?: string;
  error?: { code: string; message: string };
  reason?: string;
}

/** 服务端 `game:snapshot` 广播载荷 —— 在 `Snapshot` 之上附带回合计时截止时刻。 */
interface SnapshotOut {
  state: GameState;
  hash: string;
  serverSeq?: number;
  lastSeqByPlayer?: Record<string, number>;
  turnDeadline?: number;
}

export interface RoomSession {
  link: LinkState;
  room: RoomView | null;
  /** 由事件流 reduce 出来的对局状态；尚未开局为 `null`。 */
  state: GameState | null;
  hash: string | null;
  me: PlayerId | null;
  foe: PlayerId | null;
  /** 本回合的计时截止时刻（服务端时钟）；未计时为 `null`。 */
  turnDeadline: number | null;
  log: LogEntry[];
  notice: string;
  create(nickname: string, capacity: number): void;
  join(code: string, nickname: string): void;
  leave(): void;
  ready(): void;
  /** 推进一个阶段 —— 六阶段不可跳过（A4-2），故没有「跳到战斗」这类操作。 */
  advance(): void;
  /**
   * 结束回合 —— 引擎会从当前阶段起**逐个推进剩余阶段**直到进入下一回合，
   * 不跳阶段（`turn-end.ts`）。与超时走的是同一条链路（ADR-0011）。
   */
  endTurn(): void;
  charge(uids: string[]): void;
  play(uid: string): void;
  attack(attackerUid: string, targetUid: string): void;
  mulligan(returns: string[]): void;
  dismiss(): void;
}

const LS = { playerId: 'fc.playerId', token: 'fc.token', nickname: 'fc.nickname' } as const;

export function useRoom(): RoomSession {
  const [link, setLink] = useState<LinkState>('connecting');
  const [room, setRoom] = useState<RoomView | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [me, setMe] = useState<PlayerId | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState<string>('');
  const [turnDeadline, setTurnDeadline] = useState<number | null>(null);

  const seqRef = useRef(0);
  const meRef = useRef<PlayerId | null>(null);
  const namesRef = useRef<Record<string, string>>({});
  const stateRef = useRef<GameState | null>(null);

  /** playerId → 昵称。服务端视图里带了昵称，不必本地再维护一份。 */
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of room?.seats ?? []) if (s) map[s.playerId] = s.nickname;
    return map;
  }, [room]);

  // 同步到 ref：socket 回调只注册一次（依赖 []），但必须读到最新值。
  useEffect(() => {
    namesRef.current = names;
    meRef.current = me;
  }, [names, me]);

  const appendLog = useCallback((text: string, at: number): void => {
    setLog((prev) => [...prev, { id: prev.length + 1, at, text }].slice(-200));
  }, []);

  useEffect(() => {
    const onConnect = (): void => setLink('online');
    const onDisconnect = (): void => setLink('offline');
    const onError = (): void => setLink('offline');
    const onRoomState = (view: RoomView): void => setRoom(view);

    const onSnapshot = (snap: SnapshotOut): void => {
      stateRef.current = snap.state;
      setState(snap.state);
      setHash(snap.hash);
      setTurnDeadline(snap.turnDeadline ?? null);
      // 重连后按服务端记录的 lastSeq 续发，禁止本地计数归零重来（ADR-0011）。
      const mine = meRef.current;
      const server = mine ? (snap.lastSeqByPlayer?.[mine] ?? 0) : 0;
      if (server > seqRef.current) seqRef.current = server;
    };

    const onGameEvents = (out: EventsOut): void => {
      if (out.kind !== 'accepted') {
        setNotice(
          out.kind === 'rejected'
            ? (out.error?.message ?? out.error?.code ?? '操作被拒绝')
            : (out.reason ?? '操作被忽略'),
        );
        return;
      }
      let next = stateRef.current;
      if (!next) return; // 还没有起点状态 —— 等服务端补发快照

      for (const e of out.events ?? []) {
        next = core.reduce(next, e);
        // 用**reduce 后**的状态翻译：卡刚移动完，才能按 uid 反查到卡名。
        const text = describeEvent(e, namesRef.current, next);
        if (text) appendLog(text, e.at);
      }
      stateRef.current = next;
      setState(next);
      setHash(out.hash ?? null);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    socket.on(SOCKET_EVENTS.roomState, onRoomState);
    socket.on(SOCKET_EVENTS.gameSnapshot, onSnapshot);
    socket.on(SOCKET_EVENTS.gameEvents, onGameEvents);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
      socket.off(SOCKET_EVENTS.roomState, onRoomState);
      socket.off(SOCKET_EVENTS.gameSnapshot, onSnapshot);
      socket.off(SOCKET_EVENTS.gameEvents, onGameEvents);
    };
  }, [appendLog]);

  /** 发一条玩家 Intent。`seq` 单调递增，重连后由快照纠正。 */
  const send = useCallback((type: string, payload?: Record<string, unknown>): void => {
    const playerId = meRef.current;
    if (!playerId) {
      setNotice('尚未加入房间');
      return;
    }
    seqRef.current += 1;
    const intent: Intent = {
      type,
      actor: 'player',
      playerId,
      seq: seqRef.current,
      ...(payload ? { payload } : {}),
    };
    socket.emit(SOCKET_EVENTS.gameIntent, intent);
  }, []);

  const acceptIdentity = (res: Ack): boolean => {
    if (!res.ok || !res.playerId || !res.token) {
      setNotice(res.error ? `操作失败：${res.error}` : '操作失败');
      return false;
    }
    localStorage.setItem(LS.playerId, res.playerId);
    localStorage.setItem(LS.token, res.token);
    setMe(res.playerId);
    if (res.room) setRoom(res.room);
    if (res.snapshot) {
      stateRef.current = res.snapshot.state;
      setState(res.snapshot.state);
      setHash(res.snapshot.hash);
    }
    return true;
  };

  const create = useCallback((nickname: string, capacity: number): void => {
    localStorage.setItem(LS.nickname, nickname);
    socket.emit(SOCKET_EVENTS.roomCreate, { nickname: nickname || '玩家', capacity }, (res: Ack) => {
      if (acceptIdentity(res)) setNotice(`已建房，房间码 ${res.room?.code ?? ''}`);
    });
  }, []);

  const join = useCallback((code: string, nickname: string): void => {
    localStorage.setItem(LS.nickname, nickname);
    socket.emit(SOCKET_EVENTS.roomJoin, { code: code.trim(), nickname: nickname || '玩家' }, (res: Ack) => {
      if (acceptIdentity(res)) setNotice(`已加入房间 ${res.room?.code ?? ''}`);
    });
  }, []);

  const leave = useCallback((): void => {
    socket.emit(SOCKET_EVENTS.roomLeave, {}, (res: Ack) => {
      localStorage.removeItem(LS.playerId);
      localStorage.removeItem(LS.token);
      setMe(null);
      setRoom(null);
      stateRef.current = null;
      setState(null);
      setHash(null);
      setTurnDeadline(null);
      setNotice(res.ok ? '已离开房间' : `离开失败：${res.error ?? '未知错误'}`);
    });
  }, []);

  const ready = useCallback((): void => {
    socket.emit(SOCKET_EVENTS.roomReady, {}, (res: Ack) => {
      if (!res.ok) return setNotice(`准备失败：${res.error ?? '未知错误'}`);
      if (res.room) setRoom(res.room);
    });
  }, []);

  /** 载入时若本地存有凭据，自动重连回原房间。 */
  useEffect(() => {
    const playerId = localStorage.getItem(LS.playerId);
    const token = localStorage.getItem(LS.token);
    if (!playerId || !token) return;
    socket.emit(SOCKET_EVENTS.roomReconnect, { playerId, token }, (res: Ack) => {
      if (!res.ok || !res.room) {
        localStorage.removeItem(LS.playerId);
        localStorage.removeItem(LS.token);
        return;
      }
      setMe(playerId);
      setRoom(res.room);
      if (res.snapshot) {
        stateRef.current = res.snapshot.state;
        setState(res.snapshot.state);
        setHash(res.snapshot.hash);
        const server = res.snapshot.lastSeqByPlayer?.[playerId] ?? 0;
        if (server > seqRef.current) seqRef.current = server;
      }
      setNotice('已自动重连到原房间');
    });
  }, []);

  const foe = useMemo(() => {
    if (!me) return null;
    return room?.seats.find((s) => s && s.playerId !== me)?.playerId ?? null;
  }, [room, me]);

  const dismiss = useCallback((): void => setNotice(''), []);

  return {
    link,
    room,
    state,
    hash,
    me,
    foe,
    turnDeadline,
    log,
    notice,
    create,
    join,
    leave,
    ready,
    advance: () => send(core.INTENTS.phaseAdvance),
    endTurn: () => send(core.INTENTS.turnEnd),
    charge: (uids) => send(core.INTENTS.charge, { uids }),
    play: (uid) => send(core.INTENTS.play, { uid }),
    attack: (attackerUid, targetUid) => send(core.INTENTS.attack, { attackerUid, targetUid }),
    mulligan: (returns) => send(core.INTENTS.mulligan, { returns }),
    dismiss,
  };
}
