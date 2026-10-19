import { useEffect, useRef, useState } from 'react';

import * as core from '@app/core';
import { MAIN_DECK_SIZE, type CardInstance, type GameState, type PlayerId, type PlayerState, type Zone } from '@app/shared';

import { ACTIVATABLE_EFFECTS, CARD_POOL } from '@app/shared/cards';
import { MULLIGAN_WINDOW_MS } from '@app/shared/constants';

import CardTile from './CardTile.js';
import {
  deckDefIds,
  deckTotal,
  isDeckComplete,
  loadActiveDeckId,
  loadDecks,
  saveActiveDeckId,
} from './decks.js';
import { KEYWORD_NOTE, PHASE_LABEL } from './labels.js';
import type { RoomView } from './types.js';
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
  /** 可发动的效果列表（仅我方回合、未用次数时由调用方给出；不可用的已被过滤掉，见 effectsFor）。 */
  effects?: { id: string; label: string }[];
  onActivate?: (effectId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const def = CARD_POOL[props.card.defId];
  const power = core.unitPower(props.state, CARD_POOL, props.card.uid) ?? def?.power ?? 0;
  const notes = (def?.keywords ?? [])
    .map((k) => KEYWORD_NOTE[k])
    .filter((x): x is string => typeof x === 'string');
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
          {/* 指挥官没有力量值（docs/16 §6.2.1 / D-230）：一行只写类型，不写数值 */}
          {def ? KIND_TAG_FOR_DETAIL[def.type] : '未知'}
          {def?.type === 'commander' ? '' : ` · 费 ${def?.cost ?? 0} · 力 ${power}`}
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
        {/* 效果发动入口（ADR-0023）—— 发动按钮长在详情里，不在桌上另占位置；
            不可发动的不展示（Era 2026-10-19），卡面文本本身仍可读。 */}
        {props.effects && props.effects.length > 0 ? (
          <div className="mt-3 space-y-1">
            {props.effects.map((ef) => (
              <button
                key={ef.id}
                type="button"
                className="w-full rounded bg-emerald-800 py-2 text-xs font-medium text-emerald-50"
                onClick={() => {
                  props.onActivate?.(ef.id);
                  props.onClose();
                }}
                data-testid={`effect-${ef.id}`}
              >
                {ef.label}
              </button>
            ))}
          </div>
        ) : null}
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
  continuous: '设置',
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
        sleeping={props.sleeping ?? props.card.sleeping}
        frozen={props.card.frozen}
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
      {/* 标题行：可展开时是按钮，不可展开时是纯文本（不可操作的按钮不展示，Era 2026-10-19） */}
      {props.expandable ? (
        <button
          type="button"
          className="flex w-full items-center justify-between gap-1 text-[10px] text-slate-400"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="truncate">{props.label}</span>
          {props.badge ? (
            <span className="shrink-0 font-mono text-rose-300" data-testid={props.badgeTestId}>
              {props.badge}
            </span>
          ) : null}
          <span className="shrink-0 text-slate-200" data-testid="zone-count">
            {props.cards.length}
          </span>
        </button>
      ) : (
        <div className="flex w-full items-center justify-between gap-1 text-[10px] text-slate-400">
          <span className="truncate">{props.label}</span>
          {props.badge ? (
            <span className="shrink-0 font-mono text-rose-300" data-testid={props.badgeTestId}>
              {props.badge}
            </span>
          ) : null}
          <span className="shrink-0 text-slate-200" data-testid="zone-count">
            {props.cards.length}
          </span>
        </div>
      )}
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
 *
 * D-132：BO3 下这里分两种形态 ——
 *  - **小局结束、系列赛未分胜负**（`room.awaitingNext`）：显示比分与「开始下一局」；
 *  - **系列赛结束**：显示系列赛胜者与总比分。
 */
function GameOverPanel(props: {
  state: GameState;
  me: PlayerId;
  room: RoomView | null;
  onBack: () => void;
  onNextGame: () => void;
}): React.JSX.Element {
  const draw = props.state.draw;
  const won = props.state.winner === props.me;
  const room = props.room;
  const awaitingNext = room?.awaitingNext === true;
  // 系列赛结束时以 seriesWinner 为准（可能因对手离场提前结束，与最后一小局的 winner 一致）。
  const seriesWon = room?.seriesWinner ? room.seriesWinner === props.me : null;
  const myWins = room && props.me ? (room.wins[props.me] ?? 0) : 0;
  const foeWins = room
    ? Math.max(
        0,
        ...Object.entries(room.wins)
          .filter(([id]) => id !== props.me)
          .map(([, w]) => w),
      )
    : 0;
  const isHost = room?.hostId === props.me;
  const nextGameNo = (room?.gameNo ?? 0) + 1;

  const title = awaitingNext
    ? draw
      ? '本局平局'
      : won
        ? '本局胜利'
        : '本局败北'
    : draw
      ? '平局'
      : (seriesWon ?? won)
        ? '胜利'
        : '败北';

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <p
        className={`text-4xl font-bold ${draw ? 'text-slate-200' : (seriesWon ?? won) ? 'text-amber-300' : 'text-slate-300'}`}
        data-testid="game-result"
      >
        {title}
      </p>
      <p className="text-sm text-slate-400" data-testid="series-score">
        {room && room.format === 'bo3'
          ? `BO3 · 第 ${Math.max(1, room.gameNo)} 局结束 · 比分 我 ${myWins} : ${foeWins} 对手`
          : draw
            ? '40 轮未分胜负'
            : '对局结束'}
      </p>
      {awaitingNext ? (
        isHost ? (
          <button
            type="button"
            className="rounded bg-emerald-700 px-6 py-2 text-sm"
            onClick={props.onNextGame}
            data-testid="next-game"
          >
            开始第 {nextGameNo} 局
          </button>
        ) : (
          <p className="text-xs text-slate-500" data-testid="wait-next">
            等待房主开始第 {nextGameNo} 局…
          </p>
        )
      ) : null}
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
/**
 * 待定选择浮层（ADR-0023）—— 效果需要选择时弹出，选项即服务端给出的 `options`。
 * 统领Ⅰ的子效果选项用文案按钮；卡 uid 选项渲染成小卡。`pass`（放弃）恒可选。
 */
function ChoiceOverlay(props: {
  choice: NonNullable<GameState['pendingChoice']>;
  state: GameState;
  onChoose: (choice: string) => void;
}): React.JSX.Element {
  const { choice } = props;
  const SUB_LABEL: Readonly<Record<string, string>> = {
    l1: '1档：从弃牌区召唤随从（力量 ≤ 炎刃数）',
    l3: '3档：一个随从本回合力量 +1',
    l5: '5档：破坏一个随从（力量 ≤ 炎刃数）',
    l7: '7档：一个随从本回合对指挥官伤害 +1',
    l9: '9档：一个随从一回合一次攻击后重置',
  };
  const TITLE: Readonly<Record<string, string>> = {
    'blade-lord-1': '统领效果Ⅰ：选择要执行的效果（可再选，或放弃）',
    'blade-lord-1-target': '选择目标随从',
    'blade-lord-2': '统领效果Ⅱ：选择一张要除外的手牌',
    'blade-scout-exile': '展示到炎刃斥候 —— 是否将其除外？',
    'blade-order-summon': '号令：选择要召唤的随从',
    'blade-guard-exile': '卫士：展示到炎刃卡 —— 是否将其除外？',
    'blade-knight-attack': '骑士：可除外弃牌区一张炎刃卡，换本回合力量 +1',
    'blade-veteran-exile': '老兵：可除外弃牌区一张炎刃卡，换抽一张牌',
    'blade-tactics-target': '战术：选择一个己方随从（本回合力量 +2/+3）',
    'blade-cremation': '焚典：选择要除外的炎刃卡（其余进弃牌区）',
    'frost-adjudicator-1': '裁决官Ⅰ：按霜痕层数冻结未冻结的敌方随从',
    'frost-apprentice-freeze': '学徒：冻结一个未冻结的敌方随从',
    'frost-binder-freeze': '缚锁者：冻结一个敌方随从（已冻结则改为抽 1 张）',
    'frost-nightwatch-freeze': '守夜人：冻结至多 2 个未冻结的敌方随从',
    'frost-edict-freeze': '律令：冻结一个未冻结的敌方随从',
    'frost-coldsnap-freeze': '寒流：冻结至多 2 个未冻结的敌方随从',
    'frost-judgment-target': '审判：冻结目标；若已冻结则破坏',
    'star-gaze-pick': '凝视星空：选择 1 张加入手牌（其余置入牌库底）',
  };
  /** 多选类选择用「完成选择」，其余用「放弃」。 */
  const MULTI_SELECT = new Set(['blade-cremation', 'frost-nightwatch-freeze', 'frost-coldsnap-freeze']);

  // uid 选项 → 反查卡定义渲染小卡；子效果选项 → 文案按钮
  const findCard = (uid: string): CardInstance | undefined =>
    Object.values(props.state.players)
      .flatMap((p) => Object.values(p.zones).flat())
      .find((x) => x.uid === uid);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="choice-overlay">
      <div className="w-80 max-w-full rounded-xl border border-emerald-600/60 bg-slate-900 p-4">
        <p className="text-sm font-medium text-emerald-200">{TITLE[choice.kind] ?? '请选择'}</p>
        {/* 排队提示（H28 / D-145）：链中召唤的登场选择会在此之后连续弹出，
            不说明的话玩家会以为卡住了 */}
        {props.state.pendingChoiceQueue.length > 0 ? (
          <p className="mt-1 text-[11px] text-amber-300" data-testid="choice-queue-hint">
            另有 {props.state.pendingChoiceQueue.length} 个效果等待结算，本次回答后依次弹出
          </p>
        ) : null}
        <div className="mt-3 flex max-h-64 flex-wrap justify-center gap-2 overflow-y-auto">
          {choice.options.map((opt) => {
            if (SUB_LABEL[opt]) {
              return (
                <button
                  key={opt}
                  type="button"
                  className="w-full rounded bg-cyan-800 px-3 py-2 text-left text-xs text-cyan-50"
                  onClick={() => props.onChoose(opt)}
                  data-testid={`choice-${opt}`}
                >
                  {SUB_LABEL[opt]}
                </button>
              );
            }
            const inst = findCard(opt);
            const def = inst ? CARD_POOL[inst.defId] : undefined;
            return (
              <button
                key={opt}
                type="button"
                className="w-16 rounded border border-slate-600 bg-slate-800 p-1 text-center hover:border-emerald-400"
                onClick={() => props.onChoose(opt)}
                data-testid={`choice-card`}
              >
                <span className="block truncate text-[11px] text-slate-100">{def?.name ?? opt}</span>
                <span className="block text-[10px] text-slate-400">
                  费 {def?.cost ?? 0} / 力 {def?.power ?? 0}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="mt-3 w-full rounded bg-slate-700 py-2 text-xs"
          onClick={() => props.onChoose('pass')}
          data-testid="choice-pass"
        >
          {MULTI_SELECT.has(choice.kind) ? '完成选择（其余按卡面处理）' : '放弃'}
        </button>
      </div>
    </div>
  );
}

/**
 * 展示区（D-123，Era 2026-10-18 / 2026-10-20）—— 效果从卡组展示的卡放这里，双方各一格。
 *
 * 内容有两个来源，缺一不可：
 *  1. **状态里的 `zones.reveal`** —— 星轨「展示 → 结算 → 归位」期间卡真的停在这里，
 *     置底后从状态消失，格子随之清空（Era 2026-10-20：「效果执行的时候放在展示区」）；
 *  2. **客户端回执**（`session.revealed`）—— 焚典 / 号令 / 指挥官受伤展示这类
 *     「看一眼但卡片未离场」的翻牌，状态上没有位置，只能由回执呈现到下一批或回合结束。
 */
function revealCards(
  state: GameState,
  pid: PlayerId | null,
  echo: readonly { uid: string; defId: string }[],
): readonly { uid: string; defId: string }[] {
  const zone = pid ? (state.players[pid]?.zones.reveal ?? []) : [];
  const seen = new Set(zone.map((c) => c.uid));
  return [...zone, ...echo.filter((c) => !seen.has(c.uid))];
}

function RevealBox(props: {
  cards: readonly { uid: string; defId: string }[];
  state: GameState;
  onCardDetail?: (card: CardInstance) => void;
}): React.JSX.Element {
  return (
    <div
      className="flex h-full min-h-0 flex-col rounded border border-dashed border-slate-600 bg-slate-900/40 p-1"
      data-testid="zone-reveal"
    >
      <span className="text-[10px] text-slate-500">展示区</span>
      <div className="mt-1 flex min-h-0 flex-1 flex-wrap content-start gap-0.5 overflow-y-auto">
        {props.cards.map((rc) => {
          const inst: CardInstance = { uid: rc.uid, defId: rc.defId };
          return (
            <CardOf
              key={rc.uid}
              card={inst}
              state={props.state}
              compact
              onDetail={props.onCardDetail ? () => props.onCardDetail?.(inst) : undefined}
            />
          );
        })}
        {props.cards.length === 0 ? null : null}
      </div>
    </div>
  );
}

function WaitingRoom({ session }: { session: RoomSession }): React.JSX.Element {
  const { room, me, ready, notice, leave, setDeck } = session;
  const meReady = room?.seats.find((s) => s && s.playerId === me)?.ready ?? false;

  /**
   * 卡组（D-141）—— 准备页可改，准备后锁定（服务端同样只接受未开局）。
   * 选择存本机；发给服务端的是展开后的 30 个 defId，空数组 = 阵营默认。
   */
  const [decks] = useState(loadDecks);
  const [deckId, setDeckId] = useState(loadActiveDeckId);
  const chosen = decks.find((d) => d.id === deckId && isDeckComplete(d)) ?? null;
  const pickDeck = (id: string): void => {
    setDeckId(id);
    saveActiveDeckId(id);
    const d = decks.find((x) => x.id === id && isDeckComplete(x));
    setDeck(d ? deckDefIds(d) : []);
  };

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
      {/* 卡组（D-141）：准备前可换；准备后锁定，避免开局瞬间还在改 */}
      {!meReady && decks.length > 0 ? (
        <label className="block w-full max-w-xs text-left">
          <span className="text-xs text-slate-400">我的卡组</span>
          <select
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            value={deckId}
            onChange={(e) => pickDeck(e.target.value)}
            data-testid="waiting-deck"
          >
            <option value="">阵营默认卡组</option>
            {decks.map((d) => {
              const n = deckTotal(d);
              return (
                <option key={d.id} value={d.id} disabled={!isDeckComplete(d)}>
                  {d.name}（{n}/{MAIN_DECK_SIZE} 张{isDeckComplete(d) ? '' : '，未完成'}）
                </option>
              );
            })}
          </select>
          <p className="mt-1 text-[11px] text-slate-500" data-testid="waiting-deck-current">
            本局使用：{chosen ? chosen.name : '阵营默认卡组'}
          </p>
        </label>
      ) : null}
      {/* 已准备后按钮不展示（Era 2026-10-19），状态用纯文本呈现 */}
      {meReady ? (
        <p className="text-sm text-emerald-300" data-testid="ready-done">
          已准备，等待对手…
        </p>
      ) : (
        <button
          type="button"
          className="rounded bg-emerald-700 px-6 py-3 text-base"
          onClick={ready}
          data-testid="ready"
        >
          准备
        </button>
      )}

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
  const { room, state, me, foe, turnDeadline, log, notice, fx, revealed, dismiss } = session;
  // 手牌选中 —— Era 2026-10-18：**非多目标场景的选中必须排他**，任何时候最多一张手牌高亮。
  // （充能规则上允许任意数量（X-2），但协议支持逐张发，多张充能 = 连续多次单张操作。）
  const [picked, setPicked] = useState<string | null>(null);
  const [attacker, setAttacker] = useState<string | null>(null);
  /**
   * 认输二次确认（D-147）。
   *
   * `concede` 规则（docs/06 A3-4「随时认输」）早就实现了，但一直没有 UI 入口 ——
   * 玩家想认输只能点「离开」，而在 BO3 里离开 = 判负**整个系列赛**，差别很大。
   * 认输不可撤销，故做成两段式：第一次点变红并改文案，第二次才真的发。
   */
  const [concedeArmed, setConcedeArmed] = useState(false);
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
  /**
   * 起手换牌窗口（A8-3/A10-1 + X-17）：己方第一个充能阶段（先攻方第 1 回合、
   * 后攻方第 2 回合）、我方回合。「第一次」由 `chargeCount === 1` 判定（见 canMulligan）。
   */
  const mulliganWindow = myTurnNow && phaseNow === 'charge';
  /**
   * 换牌时间窗（Era 2026-10-19）：从「各自首次进入己方充能阶段」起算
   * MULLIGAN_WINDOW_MS 内可换，过后按钮隐藏。
   * ⚠️ 客户端时钟与服务端可能不同步，这里只做**展示**；权威判定在服务端 mulligan.ts。
   */
  const myFirstChargeAt = me && state ? (state.players[me]?.firstChargeAt ?? null) : null;
  const mulliganTimeOpen =
    !state || myFirstChargeAt === null || now - myFirstChargeAt <= MULLIGAN_WINDOW_MS;
  const mulliganOpen = mulliganWindow && mulliganTimeOpen;

  // 离开可操作阶段时清掉残留选中 —— 否则置灰后取消不了，卡在「看着被选中却动不了」。
  useEffect(() => {
    if (!canPickHand) setPicked(null);
  }, [canPickHand]);
  useEffect(() => {
    if (!canBattle) setAttacker(null);
  }, [canBattle]);
  // 换牌窗口（阶段窗口或时间窗）一过就退出换牌模式。
  useEffect(() => {
    if (!mulliganOpen && mulliganMode) {
      setMulliganMode(false);
      setMulliganPicks([]);
    }
  }, [mulliganOpen, mulliganMode]);

  if (!me || !room) {
    return <p className="p-4 text-slate-400">请从主界面创建或加入房间。</p>;
  }
  if (!state || !state.started) {
    return <WaitingRoom session={session} />;
  }

  // 对局已结束（含对手中途离开由系统代认输）—— 必须放在「等待对手加入」之前：
  // 对手离场后 state.players 里仍有其数据，但席位已空，若先判对手缺失会把
  // 结束面板永远挡住（Era 2026-10-18：一方离开后另一方卡在空白页）。
  if (state.winner !== null || state.draw) {
    return (
      <GameOverPanel
        state={state}
        me={me}
        room={room}
        onBack={session.leave}
        onNextGame={session.nextGame}
      />
    );
  }

  const mine: PlayerState | undefined = me ? state.players[me] : undefined;
  const theirs: PlayerState | undefined = foe ? state.players[foe] : undefined;
  if (!mine || !theirs) {
    return <p className="p-4 text-slate-400">等待对手加入…</p>;
  }

  const myTurn = state.seats[state.activeSeat] === me;
  /**
   * 我方有挂起的待定选择 —— 此刻引擎只放行「回答选择」和「认输」，其余 Intent 一律被拒。
   * 用它把底部操作区里**必然被拒**的按钮藏掉（Era 2026-10-19：不可操作的按钮不展示）。
   */
  const choiceOpen = state.pendingChoice !== null && state.pendingChoice.playerId === me;
  /** 换牌可用 = 窗口内（己方首个充能阶段 + 时间窗）且本局还没换过（mulliganDone 每人一次，A8-3）。 */
  const canMulligan = mulliganOpen && mine.chargeCount === 1 && !mine.mulliganDone;
  /** 抽牌阶段且未抽：我方卡组区变为「点击抽牌」发光动作（Era 2026-10-18 手动抽牌）。 */
  const canDraw = myTurn && state.phase === 'draw' && !state.drawnThisPhase && !choiceOpen;
  /**
   * 指挥官攻击（docs/16 §6.1）：战斗阶段、本回合未攻击过、非先攻方第一回合。
   * 不可操作时不展示按钮（Era 2026-10-19）。
   *
   * `!choiceOpen` 与 D-152 同一口径：待定选择挂起时引擎只放行「回答 + 认输」，
   * 攻击必然被拒 —— 留着就是「点了没反应」。
   */
  const canCommanderAttack =
    myTurn &&
    state.phase === 'battle' &&
    !choiceOpen &&
    !mine.commanderAttacked &&
    !(state.turn === 1 && state.activeSeat === 0) &&
    mine.zones.commander.length > 0;
  /**
   * 星轨观测者「攻击时【1】」（docs/17 §3）：付 1 费先展示再结算伤害。
   * 只有「指挥官是星轨观测者 + 费用区有卡 + 本回合额度够」时才给这个按钮 ——
   * 不可操作不展示（Era 2026-10-19）。
   */
  const canRevealAttack =
    canCommanderAttack &&
    mine.zones.commander[0]?.defId === 'starWatcher' &&
    mine.zones.cost.length >= 1 &&
    mine.usedCostThisTurn + 1 <= mine.maxCost;

  /**
   * 本方的成长资源（D-229 / D-230）：炎刃看除外区「炎刃」数、霜律看霜痕、星轨看星轨层数。
   * 与指挥官技能同一套计数口径，只做展示。
   */
  const myCommandDefId = mine.zones.commander[0]?.defId;
  const bladeExiled = mine.zones.exile.filter((c) => CARD_POOL[c.defId]?.name.includes('炎刃')).length;
  const myGrowth =
    myCommandDefId === 'bladeLord'
      ? `除外区「炎刃」${bladeExiled}`
      : myCommandDefId === 'frostAdjudicator'
        ? `霜痕 ${mine.frostMark}`
        : myCommandDefId === 'starWatcher'
          ? `星轨 ${mine.starTrack}`
          : '';
  /** 本回合费用使用情况（docs/16 §3.3）—— 只做展示，权威在服务端。 */
  const costText = `${mine.usedCostThisTurn}/${mine.maxCost}`;
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
   * 详情浮层里的效果发动列表（ADR-0023 / ADR-0025）。
   * 数据来自 `ACTIVATABLE_EFFECTS`（卡牌数据的一部分），
   * ⚠️ 只做**展示门槛**（读状态），能不能发动由服务端裁决（ADR-0002）。
   */
  const effectsFor = (card: CardInstance): { id: string; label: string }[] | undefined => {
    const list = ACTIVATABLE_EFFECTS[card.defId];
    if (!list || !list.length) return undefined;
    // Era 2026-10-19：不可发动的效果**不展示**（取代此前的置灰+原因）。
    const out: { id: string; label: string }[] = [];
    for (const ef of list) {
      const used = mine.effectsUsed.includes(`${card.uid}:${ef.id}`);
      const inZone =
        ef.zone === 'commander'
          ? mine.zones.commander.some((x) => x.uid === card.uid)
          : mine.zones.board.some((x) => x.uid === card.uid);
      if (!inZone || !myTurn || !!state.pendingChoice || used) continue;
      out.push({ id: ef.id, label: ef.label });
    }
    return out;
  };

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
        <CardDetail
          card={detailCard}
          state={state}
          effects={effectsFor(detailCard)}
          onActivate={(effectId) => session.activateEffect(detailCard.uid, effectId)}
          onClose={() => setDetailCard(null)}
        />
      ) : null}
      {/* 待定选择浮层（ADR-0023）—— 效果选择挂起时只放行回答/认输（引擎守卫），
          界面上也只给该玩家弹出选项。 */}
      {state.pendingChoice && state.pendingChoice.playerId === me ? (
        <ChoiceOverlay choice={state.pendingChoice} state={state} onChoose={(c) => session.chooseEffect(c)} />
      ) : null}
      {/* 对方在选择中 —— 给个明确指示，否则对面停着不动像掉线（Era：提示要明显） */}
      {state.pendingChoice && state.pendingChoice.playerId !== me ? (
        <div
          className="fixed left-1/2 top-16 z-40 -translate-x-1/2 rounded-lg border border-cyan-600/50 bg-slate-900/90 px-4 py-2 text-xs text-cyan-200"
          data-testid="foe-choosing"
        >
          对方正在选择…
        </div>
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
        {/* 赛制与比分（D-132）—— 只在 BO3 显示，BO1 显示会占位制造噪音。
            `gameNo` 是**已完成**的小局数，故进行中的是第 `gameNo + 1` 局。 */}
        {room.format === 'bo3' ? (
          <span className="text-slate-400" data-testid="series">
            第 {room.gameNo + 1} 局 · 比分{' '}
            {room.wins[me] ?? 0} : {Object.entries(room.wins).filter(([id]) => id !== me).reduce((a, [, w]) => Math.max(a, w), 0)}
          </span>
        ) : null}
        {/* 专属成长资源（D-229 / D-230）—— 玩家每轮都能看到自己在变强 */}
        {myGrowth ? (
          <span className="text-cyan-300" data-testid="my-growth">
            {myGrowth}
          </span>
        ) : null}
        {/* 指挥官攻击（docs/16 §6.1）—— 可用时才出现 */}
        {canCommanderAttack ? (
          <button
            type="button"
            className="animate-pulse rounded bg-rose-700 px-2 py-1 text-[11px] font-medium text-rose-50"
            onClick={() => session.commanderAttack()}
            data-testid="commander-attack"
          >
            指挥官攻击（1 点）
          </button>
        ) : null}
        {/* 星轨观测者：攻击时【1】展示（docs/17 §3）—— 先展示、后结算伤害 */}
        {canRevealAttack ? (
          <button
            type="button"
            className="rounded bg-indigo-700 px-2 py-1 text-[11px] font-medium text-indigo-50"
            onClick={() => session.commanderAttack(true)}
            data-testid="commander-reveal-attack"
          >
            攻击并展示（1 费）
          </button>
        ) : null}
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

          {/* ③ 对方费用区 + 随从区 1·2·3 + 展示区 —— D-123（Era 2026-10-18）：
              费用区居左、展示区居右，随从 1·2·3 与第 ④ 排**逐格对齐**。
              选中攻击方后对方随从发光提示可攻击（嘲讽过滤由引擎裁决，界面不预判）。 */}
          <section className="grid min-h-0 flex-1 auto-rows-fr grid-cols-5 gap-1">
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
            <RevealBox
              cards={revealCards(state, foe, foe ? (revealed[foe] ?? []) : [])}
              state={state}
              onCardDetail={openDetail}
            />
          </section>

          {/* 中场线 —— 双方半场的分界（桌面感）；我方回合时我方半场微光。 */}
          <div className="mx-4 border-t border-slate-600/50" />

          {/* ④ 我方费用区 + 随从区 1·2·3 + 展示区 —— 与第 ③ 排逐格对齐（D-123：费用区居左、展示区居右）。
              随从仅在我方战斗阶段且未休眠时可点选为攻击方（其余时候置灰，Era 2026-10-18）。
              整排是拖拽落点（data-drop="board"）：拖手牌到此 = 出牌（B3-1）；
              费用区自带 data-drop="cost"，closest() 命中更近的它 = 充能。 */}
          <section
            className={`grid min-h-0 flex-1 auto-rows-fr grid-cols-5 gap-1 rounded ${
              dragging?.kind === 'hand' && state.phase === 'main' ? 'ring-2 ring-cyan-400/70' : ''
            } ${myTurn ? 'shadow-[0_0_14px_rgba(52,211,153,0.12)]' : ''}`}
            data-drop="board"
          >
            <ZoneBox
              label="费用区"
              zone="cost"
              cards={mine.zones.cost}
              expandable
              state={state}
              badge={`本回合 ${costText}`}
              badgeTestId="cost-usage"
              dropKey="cost"
              highlight={dragging?.kind === 'hand' && state.phase === 'charge'}
              onCardDetail={openDetail}
            />
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
            <RevealBox
              cards={revealCards(state, me, revealed[me] ?? [])}
              state={state}
              onCardDetail={openDetail}
            />
          </section>

          {/* ⑤ 我方五区 —— 与第 ② 排（对方五区）**严格镜像**（Era 2026-10-14）。
              ② 卡组/法术/指挥官/弃牌/除外 → ⑤ 除外/弃牌/指挥官/法术/卡组。
              原第 2 格是「费用区」，导致我方**看不到自己的弃牌区**；
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
                      {/* 不可操作的按钮不展示（Era 2026-10-19）：出牌只在主要阶段、充能只在充能阶段出现 */}
                      {state.phase === 'main' ? (
                        <button
                          type="button"
                          className="rounded bg-cyan-800 px-2 py-1 text-[11px] whitespace-nowrap"
                          onClick={() => {
                            session.play(c.uid);
                            setPicked(null);
                          }}
                          data-testid="play"
                        >
                          出牌
                        </button>
                      ) : null}
                      {state.phase === 'charge' ? (
                        <button
                          type="button"
                          className="rounded bg-amber-800 px-2 py-1 text-[11px] whitespace-nowrap"
                          onClick={() => {
                            session.charge([c.uid]);
                            setPicked(null);
                          }}
                          data-testid="charge"
                        >
                          充能
                        </button>
                      ) : null}
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
          选中手牌后浮现在卡的上方（见第 ⑥ 排）。
          Era 2026-10-19：**不可操作的按钮不展示**（废止置灰方案）——
          推进/结束回合只在己方回合出现；抽牌阶段不出现推进（未抽被拒、抽完自动推进）。

          层级高于待定选择浮层（浮层 z-50 → 这里 z-[60]）：引擎守卫本来就只放行
          「回答 + 认输」，但浮层是 `fixed inset-0`，会把这一排整个盖住 ——
          于是规则允许认输、界面点不到。抬到浮层之上，界面才与引擎口径一致。 */}
      <footer className="relative z-[60] flex flex-wrap items-center gap-1">
        {myTurn && state.phase !== 'draw' && !choiceOpen ? (
          <button
            type="button"
            className="rounded bg-slate-700 px-3 py-2 text-xs sm:text-sm"
            onClick={session.advance}
            data-testid="advance"
          >
            推进阶段
          </button>
        ) : null}
        {myTurn && !choiceOpen ? (
          <button
            type="button"
            className="rounded bg-slate-700 px-3 py-2 text-xs sm:text-sm"
            onClick={session.endTurn}
            data-testid="end-turn"
          >
            结束回合
          </button>
        ) : null}
        {/* 起手换牌（A8-3/A10-1）：第一回合充能阶段 + 时间窗内可用，每人一次。
            换牌是多目标操作 —— 进入换牌模式后手牌恢复多选（排他纪律不适用）。
            不可用时不展示（Era 2026-10-19）。 */}
        {!mulliganMode
          ? canMulligan && (
              <button
                type="button"
                className="rounded bg-violet-800 px-3 py-2 text-xs sm:text-sm"
                onClick={() => {
                  setMulliganMode(true);
                  setPicked(null);
                }}
                data-testid="mulligan"
              >
                换牌
              </button>
            )
          : mulliganOpen && (
              <>
                {mulliganPicks.length > 0 ? (
                  <button
                    type="button"
                    className="rounded bg-violet-700 px-3 py-2 text-xs sm:text-sm"
                    onClick={() => {
                      session.mulligan(mulliganPicks);
                      setMulliganMode(false);
                      setMulliganPicks([]);
                    }}
                    data-testid="mulligan-confirm"
                  >
                    确认换牌（{mulliganPicks.length}）
                  </button>
                ) : null}
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
        {attacker !== null ? (
          <button
            type="button"
            className="rounded bg-rose-800 px-3 py-2 text-xs sm:text-sm"
            onClick={() => setAttacker(null)}
            data-testid="cancel-attack"
          >
            取消攻击
          </button>
        ) : null}
        <button
          type="button"
          className={
            concedeArmed
              ? 'rounded bg-rose-700 px-3 py-2 text-xs font-medium sm:text-sm'
              : 'rounded bg-slate-800 px-3 py-2 text-xs sm:text-sm'
          }
          onClick={() => {
            if (!concedeArmed) {
              setConcedeArmed(true);
              return;
            }
            setConcedeArmed(false);
            session.concede();
          }}
          data-testid={concedeArmed ? 'concede-confirm' : 'concede'}
        >
          {concedeArmed ? '确认认输（本局判负）' : '认输'}
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
