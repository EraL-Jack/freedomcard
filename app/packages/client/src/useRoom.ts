import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as core from '@app/core';
import { SOCKET_EVENTS, type CardInstance, type Faction, type GameEvent, type GameState, type Intent, type MatchFormat, type PlayerId } from '@app/shared';

import { describeEvent } from './log.js';
import { PHASE_LABEL } from './labels.js';
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

/**
 * 事件播放节奏（Era 2026-10-18 三条指令的公共地基）：
 *  - 「过阶段反馈很差」→ 阶段/回合切换要有**横幅**与停顿；
 *  - 「重置阶段自动推进，但动画要展示、停顿一下」→ 状态机瞬穿 + 客户端按节奏播放；
 *  - 「对战详情过程在卡牌动画中体现」→ 裁决/受伤/破坏各有独立的呈现节拍。
 *
 * 服务端事件不一次性 reduce 完，而是进队列**逐条播放**：每条事件先应用到状态，
 * 再按其类型停顿对应时长（横幅停留时间），让眼睛跟得上发生了什么。
 */
export interface Fx {
  id: number;
  kind: 'phase' | 'turn' | 'reset' | 'draw' | 'combat' | 'damage' | 'destroy' | 'ended';
  /** 主文案（如「战斗阶段」「裁决 2 ⚔ 1」）。 */
  text: string;
  /** 副文案（如「防守方破坏」「轮到你行动」）。 */
  sub?: string;
  /** 战斗事件的攻击方/目标 uid —— 卡片位移动画（Era：对战详情在卡牌动画中体现）。 */
  attackerUid?: string;
  targetUid?: string;
  /** 破坏呈现：被破坏卡的快照与位置（事件 reduce 后卡已离场，幽灵卡靠它渲染淡出）。 */
  destroyed?: { card: CardInstance; side: 'me' | 'foe'; slotIndex: number | null };
}

/** 各事件类型的播放停顿（毫秒）—— 0 = 不打断节奏。 */
const FX_MS: Readonly<Record<string, number>> = {
  'phase:changed': 750,
  'turn:changed': 1100,
  'units:reset': 550,
  'draw:completed': 550,
  'combat:resolved': 900,
  'commander:damaged': 800,
  'game:ended': 1600,
};

/** 破坏（战斗导致的移入弃牌区）单独停一拍。 */
const DESTROY_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  /** 正在播放的呈现事件（横幅/飘字）；无则 `null`。 */
  fx: Fx | null;
  /** 展示区内容（D-123）：按玩家记的最近一批「从卡组展示」的卡。 */
  revealed: Record<string, { uid: string; defId: string }[]>;
  notice: string;
  /**
   * 建房 —— `format` 是赛制（BO1/BO3，D-132），`faction` 是本方阵营（D-235）。
   * 两者都由建房方在界面上选择，服务端据此建立房间与卡组。
   *
   * `deck` 是自建主卡组（D-141）：30 个 `defId`；不传 = 用阵营默认卡组。
   */
  create(
    nickname: string,
    capacity: number,
    format?: MatchFormat,
    faction?: Faction,
    deck?: string[],
  ): void;
  join(code: string, nickname: string, faction?: Faction, deck?: string[]): void;
  /** 准备页换卡组（D-141）—— 未开局时可用；空数组 = 回到阵营默认。 */
  setDeck(deck: string[]): void;
  /** 开始下一小局（仅房主可用，BO3）。 */
  nextGame(): void;
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
  /** 手动抽牌（Era 2026-10-18）：抽牌阶段点击卡组触发。 */
  draw(): void;
  attack(attackerUid: string, targetUid: string): void;
  /** 指挥官攻击（docs/16 §6.1）：目标恒为敌方指挥官，每战斗阶段一次。 */
  commanderAttack(reveal?: boolean): void;
  mulligan(returns: string[]): void;
  /** 发动卡面效果（ADR-0023）—— uid 是效果来源卡，effect 是效果编号。 */
  activateEffect(uid: string, effect: string): void;
  /** 回答待定选择（choice 为选项 id 或 'pass'）。 */
  chooseEffect(choice: string): void;
  /**
   * 认输（docs/06 A3-4「随时认输」，D-147）—— 只判负**本局**；
   * BO3 里房间转入「等待下一局」，与「离开」（判负整个系列赛）不同。
   */
  concede(): void;
  dismiss(): void;
}

const LS = { playerId: 'fc.playerId', token: 'fc.token', nickname: 'fc.nickname' } as const;

/**
 * 服务端拒绝 → 玩家能看懂的一句话。
 *
 * 优先级：服务端自带的中文 `message` → 按错误码映射 → 原样展示错误码。
 * 直接展示错误码等于对玩家说天书 —— Era 2026-10-13 实测：人数填 22 超上限 8，
 * 界面只弹出「操作失败：INVALID_PAYLOAD」，不知道哪里错了、也不知道该怎么改。
 */
const ROOM_ERROR_TEXT: Readonly<Record<string, string>> = {
  INVALID_PAYLOAD: '参数不合法：昵称需 1–24 个字，人数需 1–8',
  NOT_FOUND: '房间不存在',
  NOT_IN_ROOM: '你不在任何房间里',
  ROOM_FULL: '房间已满',
  ROOM_ENDED: '对局已结束',
  INVALID_TOKEN: '重连凭据无效，请重新加入房间',
};

function failText(res: Ack): string {
  if (res.message) return `操作失败：${res.message}`;
  const mapped = res.error ? ROOM_ERROR_TEXT[res.error] : undefined;
  if (mapped) return `操作失败：${mapped}`;
  return res.error ? `操作失败（${res.error}）` : '操作失败';
}

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
  // 事件播放队列（见 FX_MS 注释）：服务端事件逐条播放而非瞬时 reduce 完。
  const queueRef = useRef<GameEvent[]>([]);
  const pumpingRef = useRef(false);
  const fxIdRef = useRef(0);
  const [fx, setFx] = useState<Fx | null>(null);
  /**
   * 展示区内容（Era 2026-10-18：效果从卡组展示的卡放展示区）——
   * 按玩家记最近一批 `card:revealed`；新批次（不同 at）替换，回合切换清空。
   */
  const [revealed, setRevealed] = useState<Record<string, { uid: string; defId: string }[]>>({});
  const revealTickRef = useRef<Record<string, number>>({});
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 从单条事件提取呈现信息（横幅/飘字文案）。
   *  `prev` 是 reduce 前的状态 —— 破坏幽灵卡要从里面捞「离场前的卡与位置」。
   *  `combatTick`：本批内最近一条裁决事件的时间戳 —— 只有**战斗上下文**的
   *  移入弃牌区才算「破坏」；出牌支付（费用区→弃牌区）同型事件不该播破坏动画。 */
  const fxOf = (
    e: GameEvent,
    prev: GameState,
    next: GameState,
    combatTick: number | null,
  ): { fx: Omit<Fx, 'id'>; ms: number } | null => {
    const meNow = meRef.current;
    switch (e.type) {
      case 'phase:changed': {
        const to = e.payload?.['to'] as keyof typeof PHASE_LABEL;
        return { fx: { kind: 'phase', text: `${PHASE_LABEL[to] ?? to}阶段` }, ms: FX_MS['phase:changed']! };
      }
      case 'turn:changed': {
        const turn = Number(e.payload?.['turn'] ?? 0);
        const mine = next.seats[next.activeSeat] === meNow;
        return {
          fx: { kind: 'turn', text: `第 ${turn} 回合`, sub: mine ? '轮到你行动' : '对手行动中' },
          ms: FX_MS['turn:changed']!,
        };
      }
      case 'units:reset':
        return { fx: { kind: 'reset', text: '随从已重置', sub: '休眠解除' }, ms: FX_MS['units:reset']! };
      case 'draw:completed':
        return { fx: { kind: 'draw', text: '抽牌完成' }, ms: FX_MS['draw:completed']! };
      case 'mulligan:done':
        return { fx: { kind: 'draw', text: '换牌完成' }, ms: FX_MS['draw:completed']! };
      case 'combat:resolved': {
        const atk = Number(e.payload?.['atkPower'] ?? 0);
        const def = Number(e.payload?.['defPower'] ?? 0);
        const outcome = String(e.payload?.['outcome'] ?? '');
        const sub =
          outcome === 'defender' ? '防守方破坏' : outcome === 'attacker' ? '攻击方破坏' : '同归于尽';
        return {
          fx: {
            kind: 'combat',
            text: `裁决 ${atk} ⚔ ${def}`,
            sub,
            attackerUid: String(e.payload?.['attackerUid'] ?? ''),
            targetUid: String(e.payload?.['targetUid'] ?? ''),
          },
          ms: FX_MS['combat:resolved']!,
        };
      }
      case 'commander:damaged': {
        const amount = Number(e.payload?.['amount'] ?? 0);
        const mine = e.payload?.['playerId'] === meNow;
        return {
          fx: { kind: 'damage', text: `-${amount}`, sub: mine ? '我方指挥官受伤' : '对方指挥官受伤' },
          ms: FX_MS['commander:damaged']!,
        };
      }
      case 'card:moved': {
        if (e.payload?.['to'] !== 'graveyard') return null;
        // 仅战斗上下文的破坏（同批裁决事件的 at 相同）；支付过牌不播破坏动画
        if (combatTick === null || e.at !== combatTick) return null;
        const uid = String(e.payload?.['uid'] ?? '');
        const pid = String(e.payload?.['playerId'] ?? '');
        const owner = prev.players[pid];
        const slotIndex = owner ? owner.zones.board.findIndex((x) => x.uid === uid) : -1;
        const card = owner
          ? (owner.zones.board.find((x) => x.uid === uid) ??
            owner.zones.commander.find((x) => x.uid === uid) ??
            null)
          : null;
        if (!card) return null;
        return {
          fx: {
            kind: 'destroy',
            text: '破坏',
            destroyed: {
              card,
              side: pid === meNow ? 'me' : 'foe',
              slotIndex: slotIndex >= 0 ? slotIndex : null,
            },
          },
          ms: DESTROY_MS,
        };
      }
      case 'game:ended': {
        const winner = e.payload?.['winner'];
        return {
          fx: { kind: 'ended', text: winner === meNow ? '胜利' : '败北', sub: '对局结束' },
          ms: FX_MS['game:ended']!,
        };
      }
      default:
        return null;
    }
  };


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

  /** 逐条播放队列里的事件：先应用到状态，再按节奏停顿（横幅停留时间）。 */
  const pump = useCallback(async (): Promise<void> => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    // 战斗上下文标记：同一批内（相同 at）的「移入弃牌区」才算战斗破坏。
    let combatTick: number | null = null;
    try {
      while (queueRef.current.length > 0) {
        const e = queueRef.current.shift()!;
        const prev = stateRef.current;
        if (!prev) continue; // 还没有起点状态 —— 等服务端补发快照
        const next = core.reduce(prev, e);
        stateRef.current = next;
        if (mountedRef.current) setState(next);
        // 用**reduce 后**的状态翻译：卡刚移动完，才能按 uid 反查到卡名。
        const text = describeEvent(e, namesRef.current, next);
        if (text) appendLog(text, e.at);

        if (e.type === 'combat:resolved') combatTick = e.at;

        // 展示区（D-123）：收集本批展示的卡（uid + defId），批次以 at 区分
        if (e.type === 'card:revealed') {
          const pid = String(e.payload?.['playerId'] ?? '');
          const uid = String(e.payload?.['uid'] ?? '');
          const defId =
            Object.values(next.players)
              .flatMap((x) => Object.values(x.zones).flat())
              .find((x) => x.uid === uid)?.defId ?? '';
          if (pid && uid) {
            const sameBatch = revealTickRef.current[pid] === e.at;
            revealTickRef.current[pid] = e.at;
            setRevealed((prev) => ({
              ...prev,
              [pid]: [...(sameBatch ? (prev[pid] ?? []) : []), { uid, defId }],
            }));
          }
        } else if (e.type === 'turn:changed') {
          setRevealed({});
          revealTickRef.current = {};
        }

        const hit = fxOf(e, prev, next, combatTick);
        if (hit) {
          fxIdRef.current += 1;
          if (mountedRef.current) setFx({ ...hit.fx, id: fxIdRef.current });
          await sleep(hit.ms);
        }
      }
    } finally {
      if (mountedRef.current) setFx(null);
      pumpingRef.current = false;
    }
  }, [appendLog]);

  // 提示条自动消退（Era 2026-10-18：提示要醒目但不该常驻）—— 4s 后自动消失。
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    const onConnect = (): void => setLink('online');
    const onDisconnect = (): void => setLink('offline');
    const onError = (): void => setLink('offline');
    const onRoomState = (view: RoomView): void => setRoom(view);

    const onSnapshot = (snap: SnapshotOut): void => {
      // 快照是新的起点：播放队列作废（重连场景下队列里的事件已被快照覆盖）。
      queueRef.current = [];
      setFx(null);
      setRevealed({});
      revealTickRef.current = {};
      // BO3 下一小局：服务端先发「未开局」的快照，再发开局事件 ——
      // 日志属于单局，跨局必须清空，否则上一局的裁决会留在战报里。
      if (!snap.state.started) setLog([]);
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
      if (!stateRef.current) return; // 还没有起点状态 —— 等服务端补发快照
      // 事件进播放队列，逐条 reduce + 按节奏停顿（见 FX_MS）。
      queueRef.current.push(...(out.events ?? []));
      setHash(out.hash ?? null);
      void pump();
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
  }, [appendLog, pump]);

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
      setNotice(failText(res));
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

  const create = useCallback(
    (
      nickname: string,
      capacity: number,
      format: MatchFormat = 'bo1',
      faction?: Faction,
      deck?: string[],
    ): void => {
      localStorage.setItem(LS.nickname, nickname);
      socket.emit(
        SOCKET_EVENTS.roomCreate,
        {
          nickname: nickname || '玩家',
          capacity,
          format,
          ...(faction ? { faction } : {}),
          // D-141：只有正好 30 张才会传；否则交给阵营默认。
          ...(deck && deck.length > 0 ? { deck } : {}),
        },
        (res: Ack) => {
          if (acceptIdentity(res)) setNotice(`已建房，房间码 ${res.room?.code ?? ''}`);
        },
      );
    },
    [],
  );

  const join = useCallback(
    (code: string, nickname: string, faction?: Faction, deck?: string[]): void => {
      localStorage.setItem(LS.nickname, nickname);
      socket.emit(
        SOCKET_EVENTS.roomJoin,
        {
          code: code.trim(),
          nickname: nickname || '玩家',
          ...(faction ? { faction } : {}),
          ...(deck && deck.length > 0 ? { deck } : {}),
        },
        (res: Ack) => {
          if (acceptIdentity(res)) setNotice(`已加入房间 ${res.room?.code ?? ''}`);
        },
      );
    },
    [],
  );

  /** 准备页换卡组（D-141）—— 服务端只在未开局时接受。 */
  const setDeck = useCallback((deck: string[]): void => {
    socket.emit(SOCKET_EVENTS.roomDeck, { deck }, (res: Ack) => {
      if (!res.ok) return setNotice(failText(res));
      if (res.room) setRoom(res.room);
      // 下拉变化本身太轻，给一句确认，避免「点了没反应」的错觉。
      setNotice('卡组已更新');
    });
  }, []);

  /** 开始下一小局（BO3）—— 仅房主可发起，服务端会校验。 */
  const nextGame = useCallback((): void => {
    socket.emit(SOCKET_EVENTS.roomNextGame, {}, (res: Ack) => {
      if (!res.ok) return setNotice(`开始下一局失败：${res.error ?? '未知错误'}`);
      if (res.room) setRoom(res.room);
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
    fx,
    revealed,
    notice,
    create,
    join,
    setDeck,
    nextGame,
    leave,
    ready,
    advance: () => send(core.INTENTS.phaseAdvance),
    endTurn: () => send(core.INTENTS.turnEnd),
    charge: (uids) => send(core.INTENTS.charge, { uids }),
    play: (uid) => send(core.INTENTS.play, { uid }),
    draw: () => send(core.INTENTS.draw),
    attack: (attackerUid, targetUid) => send(core.INTENTS.attack, { attackerUid, targetUid }),
    /**
     * 指挥官攻击（docs/16 §6.1）：目标恒为敌方指挥官，无需目标参数。
     * `reveal` 走星轨观测者的「攻击时【1】展示」（docs/17 §3）。
     */
    commanderAttack: (reveal) =>
      send(core.INTENTS.commanderAttack, reveal ? { reveal: true } : undefined),
    mulligan: (returns) => send(core.INTENTS.mulligan, { returns }),
    activateEffect: (uid, effect) => send(core.INTENTS.effectActivate, { uid, effect }),
    chooseEffect: (choice) => send(core.INTENTS.effectChoose, { choice }),
    concede: () => send(core.INTENTS.concede),
    dismiss,
  };
}
