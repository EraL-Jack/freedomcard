import { useEffect, useState } from 'react';

// 只引子路径，避免把 zod 拖进首屏产物。
import { SOCKET_EVENTS } from '@app/shared/constants';

import { socket } from './socket.js';

/**
 * ⚠️ **占位界面** —— 联机自检用，不是产品界面。
 *
 * 存在的唯一理由：房间 / 重连这些能力没有界面就没法在手机上实测。
 * 布局、视觉、交互方式一律等 Era 在 `docs/06` B 组的输入，届时**整体替换**本文件。
 * 这里刻意只做最朴素的表单与列表，不做任何设计决策。
 */

interface RoomSeatView {
  seat: number;
  playerId: string;
  nickname: string;
  connected: boolean;
}

interface RoomView {
  id: string;
  code: string;
  phase: string;
  capacity: number;
  hostId: string;
  seats: (RoomSeatView | null)[];
}

interface SnapshotView {
  hash: string;
  lastSeqByPlayer: Record<string, number>;
}

interface Ack {
  ok?: boolean;
  error?: string;
  message?: string;
  room?: RoomView;
  playerId?: string;
  token?: string;
  seat?: number;
  snapshot?: SnapshotView;
}

const LS = { playerId: 'fc.playerId', token: 'fc.token', nickname: 'fc.nickname' } as const;

export default function Lobby(): React.JSX.Element {
  const [nickname, setNickname] = useState(() => localStorage.getItem(LS.nickname) ?? '');
  const [code, setCode] = useState('');
  const [capacity, setCapacity] = useState('2');
  const [room, setRoom] = useState<RoomView | null>(null);
  const [identity, setIdentity] = useState<{ playerId: string; token: string } | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotView | null>(null);
  const [notice, setNotice] = useState<string>('');

  // 房间状态由服务端广播驱动；客户端不做本地推导。
  useEffect(() => {
    const onState = (view: RoomView) => setRoom(view);
    socket.on(SOCKET_EVENTS.roomState, onState);
    return () => {
      socket.off(SOCKET_EVENTS.roomState, onState);
    };
  }, []);

  // 载入时若本地存有凭据，自动尝试重连。
  useEffect(() => {
    const playerId = localStorage.getItem(LS.playerId);
    const token = localStorage.getItem(LS.token);
    if (!playerId || !token) return;
    setIdentity({ playerId, token });
    socket.emit(SOCKET_EVENTS.roomReconnect, { playerId, token }, (res: Ack) => {
      if (res.ok && res.room) {
        setRoom(res.room);
        setSnapshot(res.snapshot ?? null);
        setNotice('已自动重连到原房间');
      } else {
        localStorage.removeItem(LS.playerId);
        localStorage.removeItem(LS.token);
        setIdentity(null);
      }
    });
  }, []);

  const remember = (res: Ack): void => {
    if (!res.ok || !res.playerId || !res.token) return;
    localStorage.setItem(LS.playerId, res.playerId);
    localStorage.setItem(LS.token, res.token);
    localStorage.setItem(LS.nickname, nickname);
    setIdentity({ playerId: res.playerId, token: res.token });
    setRoom(res.room ?? null);
  };

  const create = (): void => {
    socket.emit(
      SOCKET_EVENTS.roomCreate,
      { nickname: nickname || '玩家', capacity: Number(capacity) },
      (res: Ack) => {
        if (!res.ok) return setNotice(`建房失败：${res.error ?? '未知错误'}`);
        remember(res);
        setNotice(`已建房，房间码 ${res.room?.code}`);
      },
    );
  };

  const join = (): void => {
    socket.emit(SOCKET_EVENTS.roomJoin, { code: code.trim(), nickname: nickname || '玩家' }, (res: Ack) => {
      if (!res.ok) return setNotice(`加入失败：${res.error ?? '未知错误'}`);
      remember(res);
      setNotice(`已加入房间 ${res.room?.code}`);
    });
  };

  const leave = (): void => {
    socket.emit(SOCKET_EVENTS.roomLeave, {}, (res: Ack) => {
      localStorage.removeItem(LS.playerId);
      localStorage.removeItem(LS.token);
      setIdentity(null);
      setRoom(null);
      setSnapshot(null);
      setNotice(res.ok ? '已离开房间' : `离开失败：${res.error ?? '未知错误'}`);
    });
  };

  const me = identity?.playerId;

  return (
    <section className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-4 text-sm">
      <h2 className="mb-1 font-medium text-amber-300">房间（占位界面 · 仅用于联机自检）</h2>
      <p className="mb-3 text-xs text-amber-200/70">
        这不是产品界面。布局与视觉等 Era 在 <code>docs/06</code> B 组输入后整体替换。
      </p>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">昵称</span>
          <input
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="玩家"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">人数（建房用）</span>
          <input
            className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            inputMode="numeric"
          />
        </label>
        <button
          className="rounded bg-slate-700 px-3 py-1.5 hover:bg-slate-600"
          onClick={create}
          disabled={room !== null}
        >
          建房
        </button>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-400">房间码</span>
          <input
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 uppercase"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC123"
          />
        </label>
        <button
          className="rounded bg-slate-700 px-3 py-1.5 hover:bg-slate-600"
          onClick={join}
          disabled={room !== null || !code.trim()}
        >
          加入
        </button>
        <button className="rounded bg-slate-800 px-3 py-1.5 hover:bg-slate-700" onClick={leave} disabled={!room}>
          离开
        </button>
      </div>

      {room ? (
        <div className="rounded border border-slate-800 bg-slate-900 p-3">
          <p className="mb-2">
            房间码 <span className="font-mono text-base text-emerald-300">{room.code}</span>
            <span className="ml-2 text-xs text-slate-400">
              {room.seats.filter(Boolean).length}/{room.capacity} 人 · {room.phase}
              {me === room.hostId ? ' · 你是房主' : ''}
            </span>
          </p>
          <ul className="space-y-1">
            {room.seats.map((s, i) => (
              <li key={i} className="text-slate-300">
                席位 {i}：
                {s ? (
                  <>
                    {s.nickname}
                    {s.playerId === me ? '（你）' : ''} ·{' '}
                    <span className={s.connected ? 'text-emerald-400' : 'text-rose-400'}>
                      {s.connected ? '在线' : '断线（席位保留中）'}
                    </span>
                  </>
                ) : (
                  <span className="text-slate-500">空</span>
                )}
              </li>
            ))}
          </ul>
          {snapshot ? (
            <p className="mt-2 text-xs text-slate-400">
              快照 hash=<span className="font-mono">{snapshot.hash}</span> · 我的 lastSeq=
              <span className="font-mono">{me ? snapshot.lastSeqByPlayer?.[me] ?? 0 : 0}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-slate-400">当前不在房间内。</p>
      )}

      {notice ? <p className="mt-2 text-xs text-amber-200">{notice}</p> : null}
    </section>
  );
}
