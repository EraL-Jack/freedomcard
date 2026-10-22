import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import * as core from '@app/core';
import { ROOM_ERROR_TEXT, SOCKET_EVENTS } from '@app/shared/constants';
import type { RoomErrorCode } from '@app/shared/constants';
import type { CardInstance, GameEvent, GameState, Intent, MatchFormat, PlayerId } from '@app/shared/types';

import { describeEvent, pushLogLine } from './log.js';
import { PHASE_LABEL, ackTimeoutText } from './labels.js';
import { sfx } from './sfx.js';
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
  kind: 'phase' | 'turn' | 'reset' | 'draw' | 'income' | 'combat' | 'damage' | 'destroy' | 'ended';
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
  // D-258：回合开始的自动充能 —— 停够一拍，让「充能 +2」看得见。
  'cost:income': 900,
  'combat:resolved': 900,
  'commander:damaged': 800,
  'game:ended': 1600,
};

/** 破坏（战斗导致的移入弃牌区）单独停一拍。 */
const DESTROY_MS = 600;

/**
 * 展示节奏（Era 2026-10-20：「卡片应该在结算期间停留，而不是闪一下就没了」）。
 *
 * 服务端把「翻牌 → 结算展示时 → 归位」放在**同一条事件流**里。客户端逐条 reduce 时
 * 若没有停顿，整批展示会在同一帧内跑完 —— 玩家只看到闪一下，展示区等于不存在。
 * 因此给两个停顿：每翻一张停一下（像逐张揭牌），整批至少可见 `REVEAL_HOLD_MS` 才允许归位。
 */
const REVEAL_FLIP_MS = 180;
const REVEAL_HOLD_MS = 900;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

import type { LogEntry } from './log.js';

/** 战报行类型定义在 `log.ts`（与 `pushLogLine` 同处，避免 id 生成规则分散）。 */
export type { LogEntry };

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

/**
 * 建房 / 加房的「进行中」状态（D-256）。
 *
 * 为什么需要它：玩家点下按钮到 ack 回来之间，界面原本**一点变化都没有**。
 * 服务端慢一点、或者 ack 丢了，玩家看到的就是「点了没反应」，于是反复点，
 * 反复点又会撞上限流 —— 越点越糟。所以点击必须**立刻**在按钮上体现出来。
 *
 * 值与按钮一一对应，不能合并成一个 `boolean`：人机对战卡住时，
 * 「创建房间」不该跟着一起显示「创建中…」。
 */
export type BusyKind = 'create' | 'create-solo' | 'join';

/**
 * 建房 / 加房的 ack 等待上限（毫秒）。
 *
 * 为什么是 8 秒：正常局域网 ack 在 100ms 内，公网经隧道也就 1s 级。
 * 8 秒还没有回应，基本可以判定这次请求回不来了（丢包 / 服务端卡住），
 * 此时「一直转圈」比「明确失败」对玩家更糟 —— 他连要不要重试都不知道。
 */
export const ACK_TIMEOUT_MS = 8_000;

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
  /**
   * 回合边界是否还在播放中（D-268 / issue #101）。
   *
   * `true` = 队列里还有 `turn:changed` 没应用。此刻 `phase` 可能已经翻到下一回合的
   * 充能，但席位还没换 —— 界面**不得**据此给出「你的回合，该这么操作」的指引。
   */
  turnPending: boolean;
  /** 正在播放的呈现事件（横幅/飘字）；无则 `null`。 */
  fx: Fx | null;
  /** 展示区内容（D-123）：按玩家记的最近一批「从卡组展示」的卡。 */
  revealed: Record<string, { uid: string; defId: string }[]>;
  notice: string;
  /** 正在等待服务端回应的操作（D-256）；`null` = 空闲。 */
  busy: BusyKind | null;
  /**
   * 建房 —— 参数用**对象**而不是位置参数。
   *
   * 位置参数在加入「人机房」「回合时限」两项后已经到第 7 个，调用处只剩一串
   * `create(name, 2, format, deck, cmdr, true, 60000)`，「哪个 true 是什么」全靠数位；
   * 对象参数让调用点自解释，也给以后加字段留了余地。
   */
  create(opts: {
    nickname: string;
    capacity: number;
    format?: MatchFormat;
    /** 30 张主卡组；空 = 服务端默认卡组。 */
    deck?: string[];
    commander?: string;
    /** 人机房（D-242）：服务端自动占一个 AI 席位，`capacity` 被强制为 2。 */
    solo?: boolean;
    /** 回合时限（H18）：30 / 60 / 180 / 999 秒，缺省用服务端默认。 */
    turnTimeoutMs?: number;
  }): void;
  join(code: string, nickname: string, deck?: string[], commander?: string): void;
  /** 准备页换卡组（D-184）—— 未开局时可用；卡组与指挥官一起换。 */
  setDeck(deck: string[], commander?: string): void;
  /** 开始下一小局（仅房主可用，BO3）。 */
  nextGame(): void;
  /**
   * 再来一局（D-309 / #125）—— 系列赛打完后与对手一起原地重开。
   *
   * 与 `nextGame` 不是同一个动作：`nextGame` 是 BO3 的局间（比分继续算、房主说了算），
   * 这个是把整场重开（比分归零、双方都得点）。人机房里 AI 不会点，玩家点一次即开。
   */
  rematch(): void;
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
  /**
   * 出牌（D-257）。
   *
   * `costUids` = 自选支付哪几张费用卡（省略则服务端按费用区顺序取前 N 张）；
   * `slot` = 随从放到第几格（0–2），该格有随从则顶替、被顶替者进弃牌区。
   */
  play(uid: string, opts?: { costUids?: string[]; slot?: number }): void;
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
 *
 * ⚠️ D-157：映射表移到了 `shared`（`ROOM_ERROR_TEXT`）并用 `Record<RoomErrorCode, string>`
 * 声明 —— 客户端原来那张表把 `ROOM_NOT_FOUND` 写成了 `NOT_FOUND`、还缺 5 个码，
 * 类型强制的全表能保证「新增错误码必须同时给文案」。
 */
function failText(res: Ack): string {
  if (res.message) return `操作失败：${res.message}`;
  if (!res.error) return '操作失败';
  const mapped = ROOM_ERROR_TEXT[res.error as RoomErrorCode];
  return `操作失败：${mapped ?? res.error}`;
}

export function useRoom(): RoomSession {
  const [link, setLink] = useState<LinkState>('connecting');
  const [room, setRoom] = useState<RoomView | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [me, setMe] = useState<PlayerId | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [notice, setNotice] = useState<string>('');
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const [turnDeadline, setTurnDeadline] = useState<number | null>(null);

  const seqRef = useRef(0);
  const meRef = useRef<PlayerId | null>(null);
  const namesRef = useRef<Record<string, string>>({});
  const stateRef = useRef<GameState | null>(null);
  /** 当前等待 ack 的操作（D-256）；超时计时器与 ack 回调用它对齐，避免旧请求的超时清掉新请求的 busy。 */
  const busyRef = useRef<BusyKind | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 请求开始：立即给出可见反馈 + 挂 8 秒兜底（D-256）。
   *
   * 这三件事必须同时发生，缺一个都会退化成「点了没反应」：
   * ① 按钮变文案（`busy`）；② 屏幕上有句话（`notice`）；③ 万一 ack 永不回来，8 秒后有个交代。
   */
  const beginRequest = (kind: BusyKind, waiting: string): void => {
    if (ackTimerRef.current !== null) clearTimeout(ackTimerRef.current);
    busyRef.current = kind;
    setBusy(kind);
    setNotice(waiting);
    ackTimerRef.current = setTimeout(() => {
      // 期间又发了别的请求 → 这条超时已经不作数。
      if (busyRef.current !== kind) return;
      busyRef.current = null;
      ackTimerRef.current = null;
      setBusy(null);
      setNotice(ackTimeoutText(ACK_TIMEOUT_MS / 1000));
    }, ACK_TIMEOUT_MS);
  };

  /** 请求结束（ack 回来了 / 被本地守卫拦下 / 发送时抛错）—— 一定要清计时器。 */
  const finishRequest = (): void => {
    busyRef.current = null;
    setBusy(null);
    if (ackTimerRef.current !== null) {
      clearTimeout(ackTimerRef.current);
      ackTimerRef.current = null;
    }
  };
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
  /**
   * 队列里还有 `turn:changed` 没应用（D-268 / issue #101）。
   *
   * 回合边界在事件流里是两条事件：`phase:changed(… → charge)` 紧跟 `turn:changed`。
   * 播放循环逐条 reduce，中间那一帧就成了「阶段已是下一回合的充能、`activeSeat` 还是上一家」
   * —— 这个局面从未真实存在过，照它算出的「你的回合 + 充能阶段」指引会误导玩家。
   * 界面据此把归属文案换成「回合切换中…」并暂停给指引（`turnGuidance`）。
   */
  const [turnPending, setTurnPending] = useState(false);
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
      /* D-258：充能阶段最需要被看见的一件事 —— 这两张是回合开始白给的。 */
      case 'cost:income': {
        const amount = Number(e.payload?.['amount'] ?? 0);
        const mine = e.payload?.['playerId'] === meNow;
        return {
          fx: { kind: 'income', text: `充能 +${amount}`, sub: mine ? '你的费用区' : '对方的费用区' },
          ms: FX_MS['cost:income']!,
        };
      }
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
        const indexInBoard = owner ? owner.zones.board.findIndex((x) => x.uid === uid) : -1;
        // D-257：残影要落在**它原来那一格**。卡上有 slot 就用它，老快照按数组下标兜底。
        const slotIndex =
          owner && indexInBoard >= 0 ? (owner.zones.board[indexInBoard]!.slot ?? indexInBoard) : -1;
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

  /*
   * 战报行的序号（#135）：**单调自增**，不能取 `prev.length + 1`。
   * 数组被截到 200 条后长度恒为 200，用长度算 id 会让此后每一行都叫 201，
   * React 报 key 冲突并可能重复/吞行。详见 `log.ts` 的 `pushLogLine`。
   */
  const logSeqRef = useRef(0);
  const appendLog = useCallback((text: string, at: number): void => {
    logSeqRef.current += 1;
    const seq = logSeqRef.current;
    setLog((prev) => pushLogLine(prev, at, text, seq));
  }, []);

  /** 逐条播放队列里的事件：先应用到状态，再按节奏停顿（横幅停留时间）。 */
  const pump = useCallback(async (): Promise<void> => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    // 战斗上下文标记：同一批内（相同 at）的「移入弃牌区」才算战斗破坏。
    let combatTick: number | null = null;
    // 本批展示区第一次「有卡」的时刻 —— 归位前据此补足最短可见时长。
    let revealShownAt: number | null = null;
    try {
      while (queueRef.current.length > 0) {
        const e = queueRef.current.shift()!;
        const prev = stateRef.current;
        if (!prev) continue; // 还没有起点状态 —— 等服务端补发快照

        // 归位（`deck:put-bottom`）会让展示区立刻清空 —— 先停够时间再应用它，
        // 否则「翻牌 → 结算 → 归位」全在同一帧，玩家看到的就是闪一下。
        if (e.type === 'deck:put-bottom' && revealShownAt !== null) {
          const rest = REVEAL_HOLD_MS - (Date.now() - revealShownAt);
          if (rest > 0) await sleep(rest);
          revealShownAt = null;
        }

        const next = core.reduce(prev, e);
        stateRef.current = next;
        if (mountedRef.current) setState(next);
        // 回合边界落地 —— 归属文案恢复成「你的回合 / 对手回合」（D-268）。
        if (e.type === 'turn:changed' && mountedRef.current) setTurnPending(false);
        // 用**reduce 后**的状态翻译：卡刚移动完，才能按 uid 反查到卡名。
        // 第 4 参是视角（`meRef.current`）：用于隐藏**对手抽牌 / 充能的卡名**（issue #136）——
        // 战报是自动推送，不能把「桌面上要主动点开才看得到」的私有流向直接刷给玩家
        // （手牌是 count 态完全不可查看；费用区是 float 态、点开浮窗可见）。
        const text = describeEvent(e, namesRef.current, next, meRef.current);
        if (text) appendLog(text, e.at);

        if (e.type === 'combat:resolved') combatTick = e.at;

        /*
         * 音效（P-06）—— 三条，与横幅同一时刻发声，听觉和视觉才对得上。
         *
         * 为什么挂在这里而不是 UI 里：这是事件流的唯一消费点，
         * 重连回放（快照之后的增量）也不会漏掉；放在组件的 useEffect 里
         * 反而会因为 fx 合并而少响几下。
         */
        if (e.type === 'commander:damaged') sfx.hit(Number(e.payload?.['amount'] ?? 1));
        else if (e.type === 'combat:resolved') sfx.hit(1);
        else if (e.type === 'draw:completed') sfx.draw();
        else if (e.type === 'game:ended') sfx.end(e.payload?.['winner'] === meRef.current);

        // 展示逐张「揭牌」的节奏：卡进展示区后停一下，让玩家看清这一张。
        if (e.type === 'card:moved' && String(e.payload?.['to'] ?? '') === 'reveal') {
          revealShownAt ??= Date.now();
          await sleep(REVEAL_FLIP_MS);
        }

        // 展示区（D-123）：收集本批展示的卡（uid + defId），批次以 at 区分。
        //
        // ⚠️ 只收集**没有进入真实展示区**的卡（Era 2026-10-20 起 `reveal` 是状态里的区域）。
        // 星轨的「展示 → 结算 → 归位」由服务端状态驱动：卡在这段时间里就在 `zones.reveal`，
        // 置底后自动消失 —— 不能用这里的客户端回执替它，否则归位后还会留在屏幕上。
        // 这里的回执只服务「看一眼但不离场」的翻牌（焚典 / 号令 / 指挥官受伤展示）。
        if (e.type === 'card:revealed') {
          const pid = String(e.payload?.['playerId'] ?? '');
          const uid = String(e.payload?.['uid'] ?? '');
          const inRevealZone = (next.players[pid]?.zones.reveal ?? []).some((x) => x.uid === uid);
          const defId =
            Object.values(next.players)
              .flatMap((x) => Object.values(x.zones).flat())
              .find((x) => x.uid === uid)?.defId ?? '';
          if (pid && uid && !inRevealZone) {
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
      /*
       * 兜底：队列已空却还挂着「回合切换中」是不可能的组合 ——
       * 唯一走到这里的异常路径是「还没有起点状态，事件被 `continue` 跳过」，
       * 那条 `turn:changed` 永远不会被应用。不在这里清掉，顶栏会永久停在
       * 「回合切换中…」且不再给任何指引（Era 最烦的「点了没反应」的变体）。
       */
      if (queueRef.current.length === 0 && mountedRef.current) setTurnPending(false);
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
      setTurnPending(false);
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
      const incoming = out.events ?? [];
      /*
       * 这一批里若含回合边界，从**入队那一刻**就把归属标成「切换中」（D-268）。
       *
       * 不能等到 `phase:changed(charge)` 应用时才标 —— 那时已经晚了一帧：
       * 中间态「阶段 充能 + 上一家还没交棒」正是要避免的那一帧。
       */
      if (incoming.some((e) => e.type === 'turn:changed')) setTurnPending(true);
      queueRef.current.push(...incoming);
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

  /**
   * 收下服务端给的席位身份。
   *
   * ⚠️ `res` 可能整个是 `undefined` —— socket.io 只在服务端**真的调用了**
   * ack 回调时才给它传参。服务端处理器中途抛异常、或事件名对不上，
   * 对方的 ack 就不会执行，这边拿到的是 `undefined`。
   * 原来直接读 `res.ok` 会在这里抛 TypeError，而它发生在 socket 回调里，
   * 界面不会有任何反应 —— 又是一种「点了没反应」（D-256）。
   */
  const acceptIdentity = (res: Ack | undefined): boolean => {
    if (!res) {
      setNotice('服务器没有返回任何结果 —— 请刷新页面后重试');
      return false;
    }
    if (!res.ok || !res.playerId || !res.token) {
      setNotice(failText(res));
      return false;
    }
    localStorage.setItem(LS.playerId, res.playerId);
    localStorage.setItem(LS.token, res.token);
    setMe(res.playerId);
    /*
     * 与下面的 `stateRef.current` **同批同步**（#136 / ADR-0065）。
     *
     * `me` 是 state，只在上面的 passive effect（`meRef.current = me`）里同步到 ref，
     * 比 `setMe` 晚一拍。正常链路（建房 / 加入 / 人机局）在 `setMe` 与开局首个事件批之间
     * 隔着「用户点准备」一整轮 render + flush，窗口不存在；但 `socket.ts` 有 `polling`
     * 回退路径，快照 / 增量包可能与本次 ack 落在**同一个 JS 任务**里 ——
     * 那样 `pump()` 读到的 `meRef.current` 还是 `null`，按 fail-closed 会连**自己**的
     * 抽牌行也降级成「抽了 1 张」。方向是安全的（多藏不泄露），但那是可见的行为退化，
     * 所以这里补一行同步，让「视角」与「起点状态」在同一次赋值里一起生效。
     *
     * 不为它单独写测试：这个窗口要求 ack 与首个事件批落在同一个 JS 任务，
     * E2E 里造不稳定（QA 在正常链路上 8/8 未复现），硬造 flaky 用例的代价高于这一行的收益。
     */
    meRef.current = res.playerId;
    if (res.room) setRoom(res.room);
    if (res.snapshot) {
      stateRef.current = res.snapshot.state;
      setState(res.snapshot.state);
      setHash(res.snapshot.hash);
    }
    return true;
  };

  const create = useCallback(
    (opts: {
      nickname: string;
      capacity: number;
      format?: MatchFormat;
      deck?: string[];
      commander?: string;
      solo?: boolean;
      turnTimeoutMs?: number;
    }): void => {
      const { nickname, capacity, format = 'bo1', deck, commander, solo, turnTimeoutMs } = opts;
      // 先表态再干活（D-256）：点击到 ack 之间原本界面毫无变化。
      beginRequest(solo ? 'create-solo' : 'create', solo ? '正在开人机房…' : '正在建房…');
      /*
       * localStorage 写入可能直接抛错（隐私模式 / 配额满 / 存储被策略禁用）。
       * 原来它在最前面且没有保护 —— 一旦抛错，整个处理器中断，界面零反馈，
       * 玩家看到的就是「点了没反应」。这里宁可少存一个昵称，也要让玩家知道发生了什么。
       */
      try {
        localStorage.setItem(LS.nickname, nickname);
      } catch {
        finishRequest();
        setNotice('浏览器不允许写入本地存储 —— 请退出无痕/隐私模式后重试');
        return;
      }
      /*
       * 断线时不发请求，直接说清楚。
       *
       * D-255（Era 2026-10-21「点击人机对战没反应」）：socket.io 在未连接时
       * `emit` 会**静默进队列**，等连上才发；于是按钮点下去毫无反馈，
       * 玩家只能反复点。断线是我们能判断的状态，就不该把「没反应」丢给玩家。
       */
      if (!socket.connected) {
        finishRequest();
        setNotice('服务端未连接，正在重连 —— 连上后再点一次');
        return;
      }
      try {
        socket.emit(
          SOCKET_EVENTS.roomCreate,
          {
            nickname: nickname || '玩家',
            capacity,
            format,
            // D-242：人机房 —— 服务端会立刻坐入 AI 并把容量收到 2。
            ...(solo ? { solo: true } : {}),
            // H18：不传 = 服务端默认 60s（与老客户端同一路径）。
            ...(turnTimeoutMs ? { turnTimeoutMs } : {}),
            // D-141 / D-184：只有正好 30 张才会传；指挥官与它成对。
            ...(deck && deck.length > 0 ? { deck } : {}),
            ...(commander ? { commander } : {}),
          },
          (res: Ack | undefined) => {
            finishRequest();
            if (acceptIdentity(res) && res) {
              setNotice(solo ? '已开人机房，对手是电脑' : `已建房，房间码 ${res.room?.code ?? ''}`);
            }
          },
        );
      } catch {
        finishRequest();
        setNotice('发送失败 —— 请刷新页面后重试');
      }
    },
    [],
  );

  const join = useCallback(
    (code: string, nickname: string, deck?: string[], commander?: string): void => {
      beginRequest('join', '正在加入房间…');
      try {
        localStorage.setItem(LS.nickname, nickname);
      } catch {
        finishRequest();
        setNotice('浏览器不允许写入本地存储 —— 请退出无痕/隐私模式后重试');
        return;
      }
      // 断线守卫同上（D-255）：加入房间也不能静默排队。
      if (!socket.connected) {
        finishRequest();
        setNotice('服务端未连接，正在重连 —— 连上后再点一次');
        return;
      }
      try {
        socket.emit(
          SOCKET_EVENTS.roomJoin,
          {
            code: code.trim(),
            nickname: nickname || '玩家',
            ...(deck && deck.length > 0 ? { deck } : {}),
            ...(commander ? { commander } : {}),
          },
          (res: Ack | undefined) => {
            finishRequest();
            if (acceptIdentity(res) && res) setNotice(`已加入房间 ${res.room?.code ?? ''}`);
          },
        );
      } catch {
        finishRequest();
        setNotice('发送失败 —— 请刷新页面后重试');
      }
    },
    [],
  );

  /** 准备页换卡组（D-184）—— 服务端只在未开局时接受；卡组与指挥官一起换。 */
  const setDeck = useCallback((deck: string[], commander?: string): void => {
    socket.emit(SOCKET_EVENTS.roomDeck, { deck, ...(commander ? { commander } : {}) }, (res: Ack) => {
      if (!res.ok) return setNotice(failText(res));
      if (res.room) setRoom(res.room);
      // 下拉变化本身太轻，给一句确认，避免「点了没反应」的错觉。
      setNotice('卡组已更新');
    });
  }, []);

  /** 开始下一小局（BO3）—— 仅房主可发起，服务端会校验。 */
  const nextGame = useCallback((): void => {
    socket.emit(SOCKET_EVENTS.roomNextGame, {}, (res: Ack) => {
      if (!res.ok) return setNotice(failText(res));
      if (res.room) setRoom(res.room);
    });
  }, []);

  /**
   * 再来一局（D-309 / #125）。
   *
   * 三种结果都要有可见差异，否则玩家分不清「点上了」和「没点上」：
   * ① 开了 → 新局的快照/事件会把界面推走，不需要额外提示；
   * ② 只记了自己一票 → 必须说「在等对手」，否则界面毫无变化；
   * ③ 对手走了 → 用人话说明，不要让按钮静默失败。
   */
  const rematch = useCallback((): void => {
    socket.emit(SOCKET_EVENTS.roomRematch, {}, (res: Ack) => {
      if (!res.ok) return setNotice(failText(res));
      if (res.room) setRoom(res.room);
      if (res.waiting) setNotice('已请求再来一局，等待对手确认…');
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
      setNotice(res.ok ? '已离开房间' : failText(res));
    });
  }, []);

  const ready = useCallback((): void => {
    socket.emit(SOCKET_EVENTS.roomReady, {}, (res: Ack) => {
      if (!res.ok) return setNotice(failText(res));
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
      // 同上（#136 / ADR-0065）：刷新重连这条链路里 ack 与快照 / 增量包最容易落在
      // 同一个 JS 任务里 —— 少了这行，重连后连**自己**的抽牌行都会退化成「抽了 1 张」。
      meRef.current = playerId;
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
    // 回合边界是否还在播放中（D-268）—— 顶栏与阶段提示据此避免「半批状态」误导。
    turnPending,
    fx,
    revealed,
    notice,
    busy,
    create,
    join,
    setDeck,
    nextGame,
    rematch,
    leave,
    ready,
    advance: () => send(core.INTENTS.phaseAdvance),
    endTurn: () => send(core.INTENTS.turnEnd),
    charge: (uids) => send(core.INTENTS.charge, { uids }),
    /*
     * 出牌（D-257）：`costUids` / `slot` 只在玩家真的选了才发。
     *
     * 一律「不带就不发」而不是发空值 —— 服务端把「没提供」与「提供但不合法」
     * 当两件事处理（后者拒绝），多发一个空数组会变成「选了 0 张费用」被拒。
     */
    play: (uid, opts) =>
      send(core.INTENTS.play, {
        uid,
        ...(opts?.costUids ? { costUids: opts.costUids } : {}),
        ...(opts?.slot !== undefined ? { slot: opts.slot } : {}),
      }),
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
