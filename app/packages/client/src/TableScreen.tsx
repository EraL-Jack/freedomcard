import { useEffect, useRef, useState } from 'react';

import * as core from '@app/core';
import type { CardInstance, GameState, PlayerId, PlayerState, Zone } from '@app/shared';

import { CARD_POOL } from '@app/shared/cards';

import CardTile from './CardTile.js';
import { KEYWORD_NOTE, PHASE_LABEL } from './labels.js';
import type { Fx, RoomSession } from './useRoom.js';

/**
 * 对战桌 —— B2 布局（我方视角，自上而下六排）+ B2-5 右侧日志列。
 *
 * ⚠️ **状态只从服务端来**：本组件不计算「这张牌能不能出」，只把选中项交给
 * `session.play(...)`，由服务端校验并广播结果（ADR-0002）。
 * 置灰只是「现在轮不到你」，不是本地裁决。
 *
 * ⚠️ B2 第 4 排与第 5 排都出现了「我方费用区」—— 原文如此，
 * `docs/01` §1.3 #3 记为待 Era 确认，此处照抄不擅自合并。
 */

/**
 * 事件呈现层 —— 横幅 / 飘字（Era 2026-10-18：过阶段反馈、对战过程动画化）。
 *
 * 一条事件一个横幅，由 `useRoom` 的播放队列按节奏切换；点击穿透，不挡操作。
 */
function FxOverlay({ fx }: { fx: Fx | null }): React.JSX.Element | null {
  if (!fx) return null;
  const tone =
    fx.kind === 'damage'
      ? 'border-rose-500/70 bg-rose-950/90 text-rose-200'
      : fx.kind === 'ended'
        ? 'border-amber-400/80 bg-amber-950/95 text-amber-100'
        : fx.kind === 'combat'
          ? 'border-cyan-500/60 bg-slate-900/95 text-cyan-100'
          : 'border-slate-500/50 bg-slate-900/95 text-slate-100';
  const size =
    fx.kind === 'damage' ? 'text-4xl font-bold' : fx.kind === 'ended' ? 'text-3xl font-bold' : 'text-2xl';
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <div key={fx.id} className={`fx-pop rounded-xl border px-8 py-4 text-center ${tone}`} data-testid="fx">
        <p className={size}>{fx.text}</p>
        {fx.sub ? <p className="mt-1 text-sm opacity-80">{fx.sub}</p> : null}
      </div>
    </div>
  );
}

/**
 * 卡牌详情浮层（Era 2026-10-18：卡牌携带效果必须可查看）。
 *
 * 内容：大卡面数值（力量为**当前值**，指挥官显示成长档位）+ 完整效果文本
 * （Era 样例卡原文已转录入卡池）+ 关键词注释（A7 已填行）。
 * 占位卡无效果文本（ADR-0018 纪律），明示等待正式卡表替换。
 */
function CardDetail(props: {
  card: CardInstance;
  state: GameState;
  onClose: () => void;
}): React.JSX.Element {
  const def = CARD_POOL[props.card.defId];
  const power = core.unitPower(props.state, CARD_POOL, props.card.uid) ?? def?.power ?? 0;
  const notes = (def?.keywords ?? [])
    .map((k) => KEYWORD_NOTE[k])
    .filter((x): x is string => typeof x === 'string');
  // 指挥官成长档位：找到持有这张指挥官卡的玩家（指挥官区持有者是唯一的）
  const cmdOwner = Object.values(props.state.players).find((p) =>
    p.zones.commander.some((c) => c.uid === props.card.uid),
  );
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={props.onClose}
      data-testid="card-detail-overlay"
    >
      <div
        className="w-72 max-w-full rounded-xl border border-slate-600 bg-slate-900 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-base font-medium text-slate-100">{def?.name ?? props.card.defId}</p>
        <p className="mt-1 text-xs text-slate-400">
          {def ? KIND_TAG_FOR_DETAIL[def.type] : '未知'} · 费 {def?.cost ?? 0} · 力 {power}
          {def?.type === 'commander' && cmdOwner ? `（成长档位 ${cmdOwner.commanderPowerIndex}）` : ''}
        </p>
        {notes.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {notes.map((t) => (
              <li key={t} className="rounded bg-slate-800/80 px-2 py-1 text-[11px] text-emerald-200">
                {t}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-3 whitespace-pre-wrap rounded bg-slate-950/60 p-2 text-xs leading-relaxed text-slate-200">
          {def?.text ?? '（占位卡：无效果文本 —— 正式卡表到位后整批替换，ADR-0018）'}
        </p>
        <button
          type="button"
          className="mt-3 w-full rounded bg-slate-700 py-2 text-sm"
          onClick={props.onClose}
          data-testid="card-detail-close"
        >
          关闭
        </button>
      </div>
    </div>
  );
}

/** 详情浮层的类型名 —— 复用 CardTile 的 KIND_TAG 口径（避免两处翻译漂移）。 */
const KIND_TAG_FOR_DETAIL: Readonly<Record<string, string>> = {
  commander: '指挥官',
  minion: '随从',
  spell: '法术',
  continuous: '持续',
};
function CardOf(props: {
  card: CardInstance;
  state: GameState;
  sleeping?: boolean;
  selected?: boolean;
  /** 当前不可操作（Era 2026-10-18：不可操作的置灰、不给高亮）。 */
  disabled?: boolean;
  /** 当前可操作（Era 2026-10-18：可操作的对象边框发光）。 */
  glow?: boolean;
  /** 查看卡牌详情（Era 2026-10-18：卡牌携带效果必须可查看）。 */
  onDetail?: () => void;
  /** 战斗呈现类名（攻击冲撞 / 受击抖动）—— 由调用方按播放中的裁决事件注入。 */
  fxClass?: string;
  /** 区域内紧凑尺寸（格子内卡片比手牌小一号，避免压排 —— D-118 截图实测）。 */
  compact?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const def = CARD_POOL[props.card.defId];
  const power = core.unitPower(props.state, CARD_POOL, props.card.uid) ?? def?.power ?? 0;
  return (
    // compact（区域/格子内）：高由格子决定、宽按 5:7 反算，不出框（Era 2026-10-18 截图实测）
    <div
      className={
        props.compact ? 'flex h-full min-h-0 items-center justify-center' : 'w-16 shrink-0 sm:w-20'
      }
    >
      <CardTile
        name={def?.name ?? props.card.defId}
        cost={def?.cost ?? 0}
        power={power}
        kind={def?.type ?? 'minion'}
        text={def?.text}
        sleeping={props.sleeping}
        selected={props.selected}
        disabled={props.disabled}
        glow={props.glow}
        fxClass={props.fxClass}
        fitHeight={props.compact}
        onDetail={props.onDetail}
        onSelect={props.onClick}
      />
    </div>
  );
}

/**
 * 区域块 —— B2-3：弃牌 / 除外 / 费用区默认**缩略**（只显示数量），点击展开全貌。
 * 费用区按 B2-3 的要求**直接显示数量**。
 *
 * `onCardClick` 是为了让**指挥官区也能当攻击目标**（ADR-0022）——
 * 此前只有随从区可点，导致「打指挥官 → 扣血 → 血空结束」这条已确认的规则
 * 在界面上走不到，只能互砍随从、永远分不出胜负。
 */
function ZoneBox(props: {
  label: string;
  zone: Zone;
  cards: readonly CardInstance[];
  state: GameState;
  expandable?: boolean;
  /** 点击区域内某张卡的回调 —— 不传则该区域不可点（默认）。 */
  onCardClick?: (uid: string) => void;
  selected?: boolean;
  /** 区域内的卡当前可操作（发光提示，Era 2026-10-18）—— 如被选为攻击目标时。 */
  glow?: boolean;
  /** 拖拽落点标记（B3-1 拖拽）：`dropKey` = 区域级落点（board/cost），`dropUid` = 单卡落点（攻击目标）。 */
  dropKey?: string;
  dropUid?: string;
  /** 拖拽悬停提示：当前拖拽可以落到这里时点亮边框。 */
  highlight?: boolean;
  /** 区域内卡的详情查看入口。 */
  onCardDetail?: (card: CardInstance) => void;
  /** 区域内卡的战斗呈现（裁决播放中给目标卡注入抖动类名）。 */
  fxFor?: (uid: string) => string | undefined;
  /**
   * 区域级动作 —— 目前只用于抽牌阶段的我方卡组区（Era 2026-10-18：
   * 抽牌需要玩家点击牌组）。存在时区域边框发光并显示动作按钮。
   */
  action?: { label: string; testId: string; onClick: () => void };
  /**
   * 区域标题右侧的徽标 —— 目前只用于**指挥官区显示血量**
   * （Era 2026-10-14：血量就在指挥官区显示）。
   */
  badge?: string;
  badgeTestId?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = props.expandable && !open ? [] : props.cards;

  return (
    // testid 挂在**容器**上而非按钮：这样断言能看到展开的卡片内容，
    // 断言的是「这个区域有什么」而不是「这个按钮写了什么」。
    <div
      className={`flex h-full min-h-0 flex-col rounded border p-1 ${
        props.action
          ? 'border-emerald-400 bg-emerald-950/40 ring-2 ring-emerald-400/70'
          : props.highlight
            ? 'border-cyan-400 bg-cyan-950/30 ring-2 ring-cyan-400/70'
            : 'border-slate-700 bg-slate-900/60'
      }`}
      data-testid={`zone-${props.zone}`}
      {...(props.dropKey ? { 'data-drop': props.dropKey } : {})}
      {...(props.dropUid ? { 'data-drop-uid': props.dropUid } : {})}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-1 text-[10px] text-slate-400"
        onClick={() => setOpen((v) => !v)}
        disabled={!props.expandable}
      >
        <span className="truncate">{props.label}</span>
        {props.badge ? (
          <span className="shrink-0 font-mono text-rose-300" data-testid={props.badgeTestId}>
            {props.badge}
          </span>
        ) : null}
        <span className="shrink-0 text-slate-200">{props.cards.length}</span>
      </button>
      {props.action ? (
        <button
          type="button"
          className="mt-1 w-full animate-pulse rounded bg-emerald-700 py-2 text-xs font-medium text-emerald-50"
          onClick={props.action.onClick}
          data-testid={props.action.testId}
        >
          {props.action.label}
        </button>
      ) : null}
      {shown.length > 0 ? (
        <div className="mt-1 flex min-h-0 flex-1 flex-wrap content-start gap-0.5">
          {shown.map((c) => (
            <CardOf
              key={c.uid}
              card={c}
              state={props.state}
              selected={props.selected}
              glow={props.glow}
              compact
              onDetail={props.onCardDetail ? () => props.onCardDetail?.(c) : undefined}
              fxClass={props.fxFor?.(c.uid)}
              onClick={props.onCardClick ? () => props.onCardClick?.(c.uid) : undefined}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 随从区的一个位置（B2 布局里的「随从区 1·2·3」，上限 3）。 */
function BoardSlot(props: {
  index: number;
  card?: CardInstance;
  state: GameState;
  selected?: boolean;
  /** 当前不可作为攻击方被选中（非战斗阶段 / 休眠 / 非我方回合）。 */
  disabled?: boolean;
  /** 当前可操作（发光提示）—— 可攻击的我方随从 / 选中攻击方后的对方目标。 */
  glow?: boolean;
  /** 拖拽源标记（data-drag-*，仅可操作时才由调用方传入）。 */
  dragKind?: 'minion';
  dragUid?: string;
  /** 拖拽落点（攻击目标，data-drop-uid）。 */
  dropUid?: string;
  /** 拖拽悬停提示。 */
  highlight?: boolean;
  /** 战斗呈现类名。 */
  fxClass?: string;
  /** 破坏幽灵卡（D-119）：格子已空但破坏动画还在播 —— 渲染淡出中的残影。 */
  ghost?: CardInstance;
  /** 查看卡详情。 */
  onDetail?: (card: CardInstance) => void;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <div
      className={`flex h-full min-h-[44px] min-w-0 flex-col items-center justify-center overflow-hidden rounded border border-dashed bg-slate-900/40 p-1 ${
        props.highlight ? 'border-cyan-400 ring-2 ring-cyan-400/70' : 'border-slate-700'
      }`}
      data-testid={`slot-${props.index}`}
      {...(props.dragKind && props.dragUid ? { 'data-drag-kind': props.dragKind, 'data-drag-uid': props.dragUid } : {})}
      {...(props.dropUid ? { 'data-drop-uid': props.dropUid } : {})}
    >
      {props.card ? (
        <CardOf
          card={props.card}
          state={props.state}
          sleeping={props.card.sleeping}
          selected={props.selected}
          disabled={props.disabled}
          glow={props.glow}
          compact
          onDetail={props.onDetail ? () => props.onDetail?.(props.card!) : undefined}
          fxClass={props.fxClass}
          onClick={props.onClick}
        />
      ) : props.ghost ? (
        <div className="w-14 sm:w-16">
          <CardTile
            name={CARD_POOL[props.ghost.defId]?.name ?? props.ghost.defId}
            cost={CARD_POOL[props.ghost.defId]?.cost ?? 0}
            power={CARD_POOL[props.ghost.defId]?.power ?? 0}
            kind={CARD_POOL[props.ghost.defId]?.type ?? 'minion'}
            fxClass="anim-destroy"
          />
        </div>
      ) : (
        <span className="text-[10px] text-slate-600">{props.index + 1}</span>
      )}
    </div>
  );
}

/**
 * 对局结束面板 —— D-122（Era 2026-10-18：一方离开后另一方卡在空白页）。
 * 正常分出胜负或对手中途离开（系统代认输）都落到这里，给出明确结果与出口。
 */
function GameOverPanel(props: {
  state: GameState;
  me: PlayerId;
  onBack: () => void;
}): React.JSX.Element {
  const won = props.state.winner === props.me;
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <p
        className={`text-4xl font-bold ${won ? 'text-amber-300' : 'text-slate-300'}`}
        data-testid="game-result"
      >
        {won ? '胜利' : '败北'}
      </p>
      <p className="text-sm text-slate-400">对局结束</p>
      <button
        type="button"
        className="rounded bg-slate-700 px-6 py-2 text-sm"
        onClick={props.onBack}
        data-testid="back-home"
      >
        返回主界面
      </button>
    </div>
  );
}

/** 未开局时的等待界面 —— B1 补充 3：双方加入并准备后即开始游戏。 */
function WaitingRoom({ session }: { session: RoomSession }): React.JSX.Element {  const { room, me, ready, notice, leave } = session;
  const meReady = room?.seats.find((s) => s && s.playerId === me)?.ready ?? false;

  return (
    <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-lg">房间码</p>
      <p className="font-mono text-3xl tracking-widest text-emerald-300" data-testid="room-code">
        {room?.code ?? '—'}
      </p>
      <p className="text-xs text-slate-400">
        {room?.seats.filter(Boolean).length ?? 0}/{room?.capacity ?? 0} 人 · {room?.phase}
      </p>
      <ul className="space-y-1 text-sm" data-testid="seats">
        {room?.seats.map((s, i) => (
          <li key={i} className={s ? 'text-slate-200' : 'text-slate-500'}>
            {i + 1} 号位：
            {s ? (
              <>
                {s.nickname}
                {s.playerId === me ? '（你）' : ''} · {s.ready ? '已准备' : '未准备'}
              </>
            ) : (
              '空'
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="rounded bg-emerald-700 px-6 py-3 text-base disabled:opacity-50"
        onClick={ready}
        disabled={meReady}
        data-testid="ready"
      >
        {meReady ? '已准备，等待对手…' : '准备'}
      </button>

      <button
        type="button"
        className="rounded border border-slate-700 px-4 py-2 text-sm"
        onClick={leave}
        data-testid="leave"
      >
        离开房间
      </button>

      {notice ? (
        <p className="text-xs text-amber-300" data-testid="notice">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

export default function TableScreen({ session }: { session: RoomSession }): React.JSX.Element {
  const { room, state, me, foe, turnDeadline, log, notice, fx, dismiss } = session;
  // 手牌选中 —— Era 2026-10-18：**非多目标场景的选中必须排他**，任何时候最多一张手牌高亮。
  // （充能规则上允许任意数量（X-2），但协议支持逐张发，多张充能 = 连续多次单张操作。）
  const [picked, setPicked] = useState<string | null>(null);
  const [attacker, setAttacker] = useState<string | null>(null);
  /** 详情浮层里正在查看的卡（Era 2026-10-18：卡牌携带效果必须可查看）。 */
  const [detailCard, setDetailCard] = useState<CardInstance | null>(null);
  /**
   * 起手换牌模式（A8-3/A10-1，D-120 补 UI 入口）。
   * 换牌是**多目标**操作（returns 数组）—— 进入模式后手牌恢复多选，
   * 不影响非多目标场景的排他纪律（Era 2026-10-18）。
   */
  const [mulliganMode, setMulliganMode] = useState(false);
  const [mulliganPicks, setMulliganPicks] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());

  /**
   * 拖拽状态（B3-1 / Era 2026-10-18）。
   *
   * ⚠️ **所有 hook 必须放在 early return 之前** —— 本组件有「等待房间」的提前返回，
   * hook 若写在返回之后，开局后 hook 数量会变多，React 直接崩溃
   * （Rendered more hooks than during the previous render，2026-10-18 实测踩过）。
   */
  const dragRef = useRef<{ uid: string; kind: 'hand' | 'minion'; startX: number; startY: number; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState<{ uid: string; kind: 'hand' | 'minion' } | null>(null);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  /** 日志框引用 —— 新日志到达时自动滚到底（战斗截图实测：新日志沉底看不见）。 */
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log.length]);

  // 每秒刷新一次，用于显示回合倒计时。
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  /**
   * 可操作性判定（Era 2026-10-18：不可操作的不给高亮/提示，尽量置灰）。
   * 全部是**状态直读**（阶段 / 回合归属 / 休眠都写在快照里），不是本地规则推算，
   * 与服务端裁决不可能出现分歧 —— 阶段守卫与 `charge.ts` / `play.ts` / `attack.ts` 一致。
   */
  const phaseNow = state && state.started ? state.phase : null;
  const myTurnNow = !!state && !!me && state.seats[state.activeSeat] === me;
  const canPickHand = myTurnNow && (phaseNow === 'charge' || phaseNow === 'main');
  const canBattle = myTurnNow && phaseNow === 'battle';
  /** 起手换牌窗口（A8-3/A10-1）：第一回合充能阶段、我方回合。 */
  const mulliganWindow = myTurnNow && phaseNow === 'charge' && state?.turn === 1;

  // 离开可操作阶段时清掉残留选中 —— 否则置灰后取消不了，卡在「看着被选中却动不了」。
  useEffect(() => {
    if (!canPickHand) setPicked(null);
  }, [canPickHand]);
  useEffect(() => {
    if (!canBattle) setAttacker(null);
  }, [canBattle]);
  // 换牌窗口一过就退出换牌模式。
  useEffect(() => {
    if (!mulliganWindow && mulliganMode) {
      setMulliganMode(false);
      setMulliganPicks([]);
    }
  }, [mulliganWindow, mulliganMode]);

  if (!me || !room) {
    return <p className="p-4 text-slate-400">请从主界面创建或加入房间。</p>;
  }
  if (!state || !state.started) {
    return <WaitingRoom session={session} />;
  }

  // 对局已结束（含对手中途离开由系统代认输）—— 必须放在「等待对手加入」之前：
  // 对手离场后 state.players 里仍有其数据，但席位已空，若先判对手缺失会把
  // 结束面板永远挡住（Era 2026-10-18：一方离开后另一方卡在空白页）。
  if (state.winner !== null) {
    return <GameOverPanel state={state} me={me} onBack={session.leave} />;
  }

  const mine: PlayerState | undefined = me ? state.players[me] : undefined;
  const theirs: PlayerState | undefined = foe ? state.players[foe] : undefined;
  if (!mine || !theirs) {
    return <p className="p-4 text-slate-400">等待对手加入…</p>;
  }

  const myTurn = state.seats[state.activeSeat] === me;
  /** 换牌可用 = 换牌窗口内且本局还没换过（mulliganDone 每人一次，A8-3）。 */
  const canMulligan = mulliganWindow && !mine.mulliganDone;
  /** 抽牌阶段且未抽：我方卡组区变为「点击抽牌」发光动作（Era 2026-10-18 手动抽牌）。 */
  const canDraw = myTurn && state.phase === 'draw' && !state.drawnThisPhase;
  // ⚠️ 客户端时钟与服务端未必同步，这里的倒计时是**示意**；权威判定在服务端（ADR-0017）。
  const remain = turnDeadline ? Math.max(0, Math.ceil((turnDeadline - now) / 1000)) : null;

  const togglePick = (uid: string): void => {
    // 拖拽落点后的 click 要抑制掉 —— 否则「拖牌上场」会变成「拖上场 + 又选中」
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setPicked((prev) => (prev === uid ? null : uid));
  };

  /** 换牌模式下的多选切换（换牌是多目标操作，排他纪律不适用）。 */
  const toggleMulliganPick = (uid: string): void => {
    setMulliganPicks((prev) => (prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid]));
  };

  /** 打开卡牌详情浮层 —— 任何可见卡都可查（信息查看不是操作，不受置灰约束）。 */
  const openDetail = (c: CardInstance): void => setDetailCard(c);

  /** 破坏幽灵卡（D-119）：破坏事件播放期间，在离空格子上渲染淡出残影。 */
  const destroyGhost = fx?.kind === 'destroy' ? (fx.destroyed ?? null) : null;

  /**
   * 裁决播放中（fx.kind === 'combat'，播放队列停 900ms）：攻击方冲撞、目标抖动。
   * 冲撞方向按半场：我方在下往上撞、对方在上往下撞。
   */
  const combatClass = (uid: string, side: 'me' | 'foe'): string | undefined => {
    if (fx?.kind !== 'combat') return undefined;
    if (fx.attackerUid === uid) return side === 'me' ? 'anim-lunge-up' : 'anim-lunge-down';
    if (fx.targetUid === uid) return 'anim-shake';
    return undefined;
  };

  /* ---------------- 拖拽（B3-1「点选+拖拽都要」/ Era 2026-10-18「模拟现实操作的卡牌」） ----------------
   *  pointer events 实现（移动端单指兼容，B5-3）。拖拽源只在**可操作**时才挂标记
   *  （与置灰/发光同一份判定）。拖回原位或无效区域 = 取消（B3-4）。
   *  拖拽阈值内视为点选；超过阈值进入拖拽并抑制随后的 click。
   *  （hook 声明在组件顶部 —— 见 dragRef 处的警告注释；这里只是普通函数。） */
  const DRAG_THRESHOLD = 8;

  const onDragMove = (e: PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD) {
      d.active = true;
      setDragging({ uid: d.uid, kind: d.kind });
    }
    if (d.active) setDragPos({ x: e.clientX, y: e.clientY });
  };

  const onDragUp = (e: PointerEvent): void => {
    window.removeEventListener('pointermove', onDragMove);
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    setDragPos(null);
    if (!d || !d.active) return;
    // 抑制紧随其后的 click —— 否则「拖牌上场」会变成「拖上场 + 又选中」。
    // ⚠️ 只在**同一事件循环**内有效：浏览器只在 pointerdown/up 落在同一元素时才补发
    // click；拖到别处松手时根本不会有点选，标志若不自动清零会吃掉下一次真实点击
    // （2026-10-18 E2E 实测：拖拽后第一次点选手牌被吞，充能按钮不弹出）。
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-drop],[data-drop-uid]');
    if (!hit) return; // 拖到无效区域 = 取消（B3-4）
    if (d.kind === 'hand') {
      const drop = hit.dataset['drop'];
      if (drop === 'board' && state.phase === 'main') session.play(d.uid);
      else if (drop === 'cost' && state.phase === 'charge') session.charge([d.uid]);
    } else {
      const targetUid = hit.dataset['dropUid'];
      if (targetUid) session.attack(d.uid, targetUid);
    }
  };

  /** 事件委托：拖拽源以 data-drag-* 标记挂在卡容器上（仅可操作时才挂）。 */
  const onTablePointerDown = (e: React.PointerEvent): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-uid]');
    if (!el) return;
    dragRef.current = {
      uid: el.dataset['dragUid']!,
      kind: el.dataset['dragKind'] as 'hand' | 'minion',
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp, { once: true });
  };

  /** 拖拽中的卡牌预览信息（浮动跟随指针的迷你卡）。 */
  const dragCard = dragging
    ? (mine.zones.hand.find((c) => c.uid === dragging.uid) ??
      mine.zones.board.find((c) => c.uid === dragging.uid) ??
      null)
    : null;

  const slots = [0, 1, 2];

  return (
    // D-118 桌面氛围：深色毛毡底 + 中线分隔 + 我方回合时我方半场微光（docs/11 R2）。
    <div className="flex h-dvh flex-col gap-1 bg-[#151b26] p-1 sm:p-2" onPointerDown={onTablePointerDown}>
      {/* 阶段进度条常显（Era 2026-10-18：过阶段反馈差）—— 六阶段一排，当前阶段高亮。
          与横幅分工：进度条回答「我在哪」，横幅回答「刚发生了什么」。 */}
      <nav className="flex items-center justify-center gap-1" data-testid="phase-track">
        {core.PHASE_ORDER.map((ph) => (
          <span
            key={ph}
            className={`rounded-full px-2 py-0.5 text-[10px] sm:text-[11px] ${
              ph === state.phase
                ? 'bg-amber-500 font-medium text-slate-950'
                : 'border border-slate-700 text-slate-500'
            }`}
          >
            {PHASE_LABEL[ph]}
          </span>
        ))}
      </nav>
      {/* 卡牌详情浮层 —— 信息查看（任何阶段可用，不受回合/阶段置灰约束）。
          B3-2 的「不要弹窗」约束的是**出牌确认**；详情查看按 docs/11 X-13 默认建议用大卡浮层。 */}
      {detailCard ? (
        <CardDetail card={detailCard} state={state} onClose={() => setDetailCard(null)} />
      ) : null}
      {/* 回合数 / 计时居中（B2-5） */}
      <header className="flex items-center justify-center gap-3 text-xs sm:text-sm">
        <span data-testid="turn">第 {state.turn} 回合</span>
        <span className="text-slate-400">阶段 {PHASE_LABEL[state.phase]}</span>
        <span className="text-slate-400">计时 {remain === null ? '—' : `${remain}s`}</span>
        {/*
          血量**不在**这里显示 —— Era 2026-10-14 指定：血量就在指挥官区显示。
          故血量徽标挂在两侧的指挥官区上（见下方 `badge`）。
        */}
        <span className={myTurn ? 'text-emerald-400' : 'text-slate-500'}>
          {myTurn ? '你的回合' : '对手回合'}
        </span>
      </header>

      {/* 事件呈现层（横幅/飘字）+ 提示 toast —— Era 2026-10-18：
          提示要醒目（中央 toast 而非底栏小字），可操作对象发光。 */}
      <FxOverlay fx={fx} />
      {notice ? (
        <button
          type="button"
          className="fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded-lg border border-amber-500/60 bg-amber-950/95 px-4 py-2 text-sm text-amber-100 shadow-lg"
          onClick={dismiss}
          data-testid="notice"
        >
          {notice}
        </button>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-1">
        {/* 对战桌主体 —— 四排网格各 `flex-1` **平分**剩余高度，格子随之撑满整桌：
            此前容器用 justify-between 只把排「拉开」，排本身仍只有内容高，
            排与排之间全是空白（Era 2026-10-14 实机反馈「格子不铺满」）。
            两排手牌条保持内容高；内容超出时靠 overflow-y-auto 滚动。 */}
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {/* ① 对方手牌 —— 只显示张数，不暴露内容 */}
          <section className="rounded border border-slate-700 bg-slate-900/40 px-2 py-1 text-[11px] text-slate-400">
            对方手牌 {theirs.zones.hand.length} 张
          </section>

          {/* ② 对方五区 —— flex-1 平分桌高；auto-rows-fr 让行撑满排高（格子因此铺满） */}
          <section className="grid min-h-0 flex-1 auto-rows-fr grid-cols-5 gap-1">
            <ZoneBox label="卡组区" zone="deck" cards={theirs.zones.deck} expandable state={state} onCardDetail={openDetail} />
            <ZoneBox label="法术区" zone="spell" cards={theirs.zones.spell} expandable state={state} onCardDetail={openDetail} />
            {/* ADR-0022：指挥官也是合法攻击目标 —— 否则只能互砍随从，永远分不出胜负。
                嘲讽优先由引擎裁决（A7），界面不预判，被拒就显示服务端原因。 */}
            <ZoneBox
              label="指挥官"
              zone="commander"
              cards={theirs.zones.commander}
              state={state}
              badge={`血 ${theirs.health}`}
              badgeTestId="hp-foe"
              glow={attacker !== null}
              dropUid={theirs.zones.commander[0]?.uid}
              highlight={dragging?.kind === 'minion'}
              onCardDetail={openDetail}
              fxFor={(uid) => combatClass(uid, 'foe')}
              onCardClick={
                attacker && myTurn
                  ? (uid) => {
                      session.attack(attacker, uid);
                      setAttacker(null);
                    }
                  : undefined
              }
            />
            <ZoneBox label="弃牌区" zone="graveyard" cards={theirs.zones.graveyard} expandable state={state} onCardDetail={openDetail} />
            <ZoneBox label="除外区" zone="exile" cards={theirs.zones.exile} expandable state={state} onCardDetail={openDetail} />
          </section>

          {/* ③ 对方费用区 + 随从区 1·2·3 —— flex-1 平分桌高。
              选中攻击方后对方随从发光提示可攻击（Era 2026-10-18）；
              嘲讽过滤由引擎裁决（ADR-0022 注释），界面不预判。 */}
          <section className="grid min-h-0 flex-1 auto-rows-fr grid-cols-4 gap-1">
            <ZoneBox label="费用区" zone="cost" cards={theirs.zones.cost} expandable state={state} onCardDetail={openDetail} />
            {slots.map((i) => (
              <BoardSlot
                key={i}
                index={i}
                state={state}
                card={theirs.zones.board[i]}
                glow={attacker !== null && !!theirs.zones.board[i]}
                dropUid={theirs.zones.board[i]?.uid}
                highlight={dragging?.kind === 'minion' && !!theirs.zones.board[i]}
                fxClass={theirs.zones.board[i] ? combatClass(theirs.zones.board[i]!.uid, 'foe') : undefined}
                ghost={
                  destroyGhost && destroyGhost.side === 'foe' && destroyGhost.slotIndex === i
                    ? destroyGhost.card
                    : undefined
                }
                onDetail={openDetail}
                onClick={
                  attacker && myTurn
                    ? () => {
                        const uid = theirs.zones.board[i]?.uid;
                        if (uid) session.attack(attacker, uid);
                        setAttacker(null);
                      }
                    : undefined
                }
              />
            ))}
          </section>

          {/* 中场线 —— 双方半场的分界（桌面感）；我方回合时我方半场微光。 */}
          <div className="mx-4 border-t border-slate-600/50" />

          {/* ④ 我方随从区 1·2·3 + 费用区 —— flex-1 平分桌高。
              随从仅在我方战斗阶段且未休眠时可点选为攻击方（其余时候置灰，Era 2026-10-18）。
              整排是拖拽落点（data-drop="board"）：拖手牌到此 = 出牌（B3-1）。 */}
          <section
            className={`grid min-h-0 flex-1 auto-rows-fr grid-cols-4 gap-1 rounded ${
              dragging?.kind === 'hand' && state.phase === 'main' ? 'ring-2 ring-cyan-400/70' : ''
            } ${myTurn ? 'shadow-[0_0_14px_rgba(52,211,153,0.12)]' : ''}`}
            data-drop="board"
          >
            {slots.map((i) => {
              const mc = mine.zones.board[i];
              const minionOperable = !!mc && canBattle && !mc.sleeping;
              return (
                <BoardSlot
                  key={i}
                  index={i}
                  state={state}
                  card={mc}
                  selected={attacker === mc?.uid}
                  onDetail={openDetail}
                  disabled={!canBattle || (mc?.sleeping ?? false)}
                  glow={canBattle && !(mc?.sleeping ?? false) && attacker !== mc?.uid && !!mc}
                  dragKind={minionOperable ? 'minion' : undefined}
                  dragUid={minionOperable ? mc?.uid : undefined}
                  fxClass={mc ? combatClass(mc.uid, 'me') : undefined}
                  ghost={
                    destroyGhost && destroyGhost.side === 'me' && destroyGhost.slotIndex === i
                      ? destroyGhost.card
                      : undefined
                  }
                  onClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    const uid = mc?.uid;
                    setAttacker((prev) => (prev === uid ? null : (uid ?? null)));
                  }}
                />
              );
            })}
            <ZoneBox
              label="费用区"
              zone="cost"
              cards={mine.zones.cost}
              expandable
              state={state}
              dropKey="cost"
              highlight={dragging?.kind === 'hand' && state.phase === 'charge'}
              onCardDetail={openDetail}
            />
          </section>

          {/* ⑤ 我方五区 —— 与第 ② 排（对方五区）**严格镜像**（Era 2026-10-14）。
              ② 卡组/法术/指挥官/弃牌/除外 → ⑤ 除外/弃牌/指挥官/法术/卡组。
              原第 2 格是「费用区」，导致我方**没有弃牌区**（玩家看不到自己的墓地）；
              费用区在第 ④ 排已有一格，故此处换成弃牌区不丢信息。
              flex-1 平分桌高。 */}
          <section className="grid min-h-0 flex-1 auto-rows-fr grid-cols-5 gap-1">
            <ZoneBox label="除外区" zone="exile" cards={mine.zones.exile} expandable state={state} onCardDetail={openDetail} />
            <ZoneBox label="弃牌区" zone="graveyard" cards={mine.zones.graveyard} expandable state={state} onCardDetail={openDetail} />
            <ZoneBox
              label="指挥官"
              zone="commander"
              cards={mine.zones.commander}
              state={state}
              badge={`血 ${mine.health}`}
              badgeTestId="hp-me"
              onCardDetail={openDetail}
              fxFor={(uid) => combatClass(uid, 'me')}
            />
            <ZoneBox label="法术区" zone="spell" cards={mine.zones.spell} expandable state={state} onCardDetail={openDetail} />
            {/* 抽牌阶段未抽时，卡组区变为发光动作「点击抽牌」（Era 2026-10-18 手动抽牌） */}
            <ZoneBox
              label="卡组区"
              zone="deck"
              cards={mine.zones.deck}
              expandable
              state={state}
              action={
                canDraw ? { label: '点击抽牌', testId: 'draw-deck', onClick: () => session.draw() } : undefined
              }
            />
          </section>

          {/* ⑥ 我方手牌 —— 可横向滚动（B2-2）。
              Era 2026-10-18 两条：
              1. 非充能/主要阶段手牌**置灰不可点**（不可操作不给高亮）；
              2. 选中**排他**（最多一张高亮），操作按钮**挂在卡的附近**（B3-2），
                 不再放底部固定操作条。 pt-9 给浮出的按钮组留位。 */}
          <section className="overflow-x-auto rounded border border-slate-700 bg-slate-900/40 p-1 pt-9">
            <div className="flex gap-1" data-testid="hand">
              {mine.zones.hand.map((c) => (
                <div
                  key={c.uid}
                  className="relative"
                  {...(canPickHand && !mulliganMode ? { 'data-drag-kind': 'hand', 'data-drag-uid': c.uid } : {})}
                >
                  {picked === c.uid && !mulliganMode ? (
                    <div className="absolute -top-8 left-1/2 z-10 flex -translate-x-1/2 gap-1">
                      <button
                        type="button"
                        className="rounded bg-cyan-800 px-2 py-1 text-[11px] whitespace-nowrap disabled:opacity-40"
                        disabled={state.phase !== 'main'}
                        onClick={() => {
                          session.play(c.uid);
                          setPicked(null);
                        }}
                        data-testid="play"
                      >
                        出牌
                      </button>
                      <button
                        type="button"
                        className="rounded bg-amber-800 px-2 py-1 text-[11px] whitespace-nowrap disabled:opacity-40"
                        disabled={state.phase !== 'charge'}
                        onClick={() => {
                          session.charge([c.uid]);
                          setPicked(null);
                        }}
                        data-testid="charge"
                      >
                        充能
                      </button>
                    </div>
                  ) : null}
                  <CardOf
                    card={c}
                    state={state}
                    selected={mulliganMode ? mulliganPicks.includes(c.uid) : picked === c.uid}
                    disabled={!canPickHand}
                    glow={mulliganMode || (canPickHand && picked !== c.uid)}
                    onDetail={() => openDetail(c)}
                    onClick={() => (mulliganMode ? toggleMulliganPick(c.uid) : togglePick(c.uid))}
                  />
                </div>
              ))}
              {mine.zones.hand.length === 0 ? (
                <span className="px-2 text-[11px] text-slate-500">手牌为空</span>
              ) : null}
            </div>
          </section>
        </div>

        {/* 右侧一列：日志框 + 对话框分开展示（B2-5） */}
        <aside className="hidden w-40 shrink-0 flex-col gap-1 sm:flex md:w-56">
          <div
            ref={logRef}
            className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-700 bg-slate-900/60 p-1 text-[11px]"
            data-testid="log"
          >
            {log.map((l) => (
              <p key={l.id} className="text-slate-300">
                {l.text}
              </p>
            ))}
          </div>
          <div className="h-20 rounded border border-slate-700 bg-slate-900/60 p-1 text-[11px] text-slate-500">
            对话框（占位）
          </div>
        </aside>
      </div>

      {/* 操作条 —— 只发 Intent，不做本地裁决。
          「出牌 / 充能」不在此处 —— Era 2026-10-18：卡牌的操作按钮挂在卡的附近，
          选中手牌后浮现在卡的上方（见第 ⑥ 排）。 */}
      <footer className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          className="rounded bg-slate-700 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
          onClick={session.advance}
          disabled={!myTurn}
          data-testid="advance"
        >
          推进阶段
        </button>
        <button
          type="button"
          className="rounded bg-slate-700 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
          onClick={session.endTurn}
          disabled={!myTurn}
          data-testid="end-turn"
        >
          结束回合
        </button>
        {/* 起手换牌（A8-3/A10-1）：第一回合充能阶段可用，每人一次。
            换牌是多目标操作 —— 进入换牌模式后手牌恢复多选（排他纪律不适用）。 */}
        {!mulliganMode ? (
          <button
            type="button"
            className="rounded bg-violet-800 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
            onClick={() => {
              setMulliganMode(true);
              setPicked(null);
            }}
            disabled={!canMulligan}
            data-testid="mulligan"
          >
            换牌
          </button>
        ) : (
          <>
            <button
              type="button"
              className="rounded bg-violet-700 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
              onClick={() => {
                session.mulligan(mulliganPicks);
                setMulliganMode(false);
                setMulliganPicks([]);
              }}
              disabled={mulliganPicks.length === 0}
              data-testid="mulligan-confirm"
            >
              确认换牌（{mulliganPicks.length}）
            </button>
            <button
              type="button"
              className="rounded bg-slate-700 px-3 py-2 text-xs sm:text-sm"
              onClick={() => {
                setMulliganMode(false);
                setMulliganPicks([]);
              }}
              data-testid="mulligan-cancel"
            >
              取消换牌
            </button>
          </>
        )}
        <button
          type="button"
          className="rounded bg-rose-800 px-3 py-2 text-xs disabled:opacity-40 sm:text-sm"
          onClick={() => setAttacker(null)}
          disabled={attacker === null}
          data-testid="cancel-attack"
        >
          取消攻击
        </button>
        <button
          type="button"
          className="rounded bg-slate-800 px-3 py-2 text-xs sm:text-sm"
          onClick={session.leave}
          data-testid="leave"
        >
          离开
        </button>
      </footer>

      {/* 拖拽预览 —— 跟随指针的浮动卡（B3-1 拖拽手感）。pointer-events-none 不挡落点判定。 */}
      {dragCard && dragPos ? (
        <div
          className="pointer-events-none fixed z-50 w-16 opacity-90"
          style={{ left: dragPos.x - 32, top: dragPos.y - 44 }}
          data-testid="drag-preview"
        >
          <CardTile
            name={CARD_POOL[dragCard.defId]?.name ?? dragCard.defId}
            cost={CARD_POOL[dragCard.defId]?.cost ?? 0}
            power={core.unitPower(state, CARD_POOL, dragCard.uid) ?? CARD_POOL[dragCard.defId]?.power ?? 0}
            kind={CARD_POOL[dragCard.defId]?.type ?? 'minion'}
          />
        </div>
      ) : null}
    </div>
  );
}
