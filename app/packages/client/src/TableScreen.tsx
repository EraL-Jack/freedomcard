import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import * as core from '@app/core';
import { MAIN_DECK_SIZE } from '@app/shared/constants';
import type { CardInstance, GameState, PlayerId, PlayerState, Zone } from '@app/shared/types';

import { ACTIVATABLE_EFFECTS, CARD_POOL } from '@app/shared/cards';
import { RECONNECT_GRACE_MS, TURN_TIMEOUT_MS } from '@app/shared/constants';
import { BLADE_EXILE_TIERS } from '@app/shared/constants';

import CardTile from './CardTile.js';
import IntroGuide, { INTRO_SEEN_KEY } from './IntroGuide.js';
import {
  listSelectionOptions,
  loadActiveDeckId,
  saveActiveDeckId,
  selectionForPlay,
} from './decks.js';
import { REPLAY_VIEW_ENABLED } from './features.js';
import { KEYWORD_NOTE, PHASE_LABEL, endReasonText, linkBannerText, turnTimeoutLabel } from './labels.js';
import {
  actionability,
  choiceSideLabels,
  dragDropIntent,
  turnGuidance,
  type Actionability,
} from './selectors.js';
import type { RoomView } from './types.js';
import type { Fx, RoomSession } from './useRoom.js';
import { isSfxMuted, setSfxMuted } from './sfx.js';

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
        : fx.kind === 'income'
          ? 'border-emerald-400/70 bg-emerald-950/90 text-emerald-100'
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
 * 局内数值一律显示**实际值**（D-232）；白板卡没有效果文本，明示「无额外效果」。
 */
function CardDetail(props: {
  card: CardInstance;
  state: GameState;
  /** 可发动的效果列表（仅我方回合、未用次数时由调用方给出；不可用的已被过滤掉，见 effectsFor）。 */
  effects?: { id: string; label: string }[];
  onActivate?: (effectId: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  /*
   * Esc 关闭（issue #124）。
   *
   * 右键 / 长按打开的浮层是 `fixed inset-0` 的全屏遮罩，键鼠用户的本能是敲 Esc ——
   * 原来按了毫无反应，只能去点「关闭」。遮罩把桌子挡住了，很容易以为界面卡死。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  /*
   * 打开时把焦点移进浮层（issue #124 同条）。
   *
   * 不移动焦点的话，键盘用户的 Tab 还在背后的桌子上走 —— 视觉上浮层在前面、
   * 焦点在后面，按回车触发的是看不见的按钮。落在「关闭」上：它是浮层里
   * 唯一必然存在的按钮（效果按钮要看牌）。
   */
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const def = CARD_POOL[props.card.defId];
  const power = core.unitPower(props.state, CARD_POOL, props.card.uid) ?? def?.power ?? 0;
  // 局内一律显示**实际值**（D-232）：实际支付费用 + 当前力量下的打脸伤害。
  const statLine =
    def === undefined
      ? ''
      : def.type === 'commander'
        ? ''
        : ` · 费 ${core.costToPay(def)} · 力 ${power}` +
          (def.type === 'minion' ? ` · 伤 ${core.faceDamageOf(def, power)}` : '');
  const notes = (def?.keywords ?? [])
    .map((k) => KEYWORD_NOTE[k])
    .filter((x): x is string => typeof x === 'string');
  return (
    <div
      /* D-265：z 值要比堆叠区浮窗（z-50）高 —— 从浮窗里长按一张卡看详情，
         详情必须压在浮窗上面，否则「点了没反应」（其实是开在下面了）。 */
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
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
          {statLine}
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
          {/* D-232：`text` 只写效果描述（数值走上方数值行），白板随从没有描述 */}
          {def?.text ?? '无额外效果。'}
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
          ref={closeRef}
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

/**
 * 堆叠区浮窗（D-265，Era 2026-10-21）。
 *
 * > 用浮窗显示堆叠区内容，而不是直接在牌桌上显示，你牌桌怎么都塞不下这么多卡吧
 *
 * 原来点区域标题是**在区域框里**把卡 flex-wrap 铺开：弃牌区到 15 张、费用区到 10 张时
 * 那一格根本放不下，只会被 `overflow-hidden` 裁掉 —— 玩家既看不全，区域也被挤变形。
 * 牌桌的可视面积是固定的，**堆叠区的上限却随对局增长**，所以这件事不能靠「排得更紧」解决，
 * 只能把内容移出牌桌。
 *
 * 浮窗是纯展示层：卡面 + 长按详情（长按委托挂在桌子根节点上，`data-card-uid` 照样命中）。
 * 不改任何状态，关掉即回到牌桌。
 */
function ZoneFloat(props: {
  label: string;
  cards: readonly CardInstance[];
  state: GameState;
  onClose: () => void;
}): React.JSX.Element {
  /*
   * 挂到 `document.body`（portal）而不是区域容器内部，有两个实打实的理由：
   *  1. 语义 —— 浮窗不是「区域里的一堆卡」，区域里就该只有区名与张数；
   *     留在区域内的话，`zone-cost` 里数得到浮窗的卡，测试与后续逻辑都会被带偏。
   *  2. `fixed` 的可靠性 —— 祖先一旦有 transform / filter / contain，
   *     `fixed` 就退化成相对祖先定位。挂到 body 上永远不受影响。
   */
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3"
      onClick={props.onClose}
      data-testid="zone-float"
    >
      <div
        className="flex max-h-[84vh] w-full max-w-3xl flex-col rounded-xl border border-slate-600 bg-slate-900 p-3"
        // 点面板本体不该关窗（只有遮罩与「关闭」关）
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-slate-100">
            {props.label}
            <span className="ml-2 text-xs font-normal text-slate-400">{props.cards.length} 张</span>
          </p>
          <button
            type="button"
            className="rounded bg-slate-700 px-3 py-1 text-xs"
            onClick={props.onClose}
            data-testid="zone-float-close"
          >
            关闭
          </button>
        </div>
        {props.cards.length > 0 ? (
          /*
           * 卡片宽度交给网格（`CardOf fluid`），高度由 `aspect-[5/7]` 自己算 ——
           * 不再依赖父级高度，所以换行、滚动都不会把卡压成窄条。
           * 390px 三列、宽屏五列：窄屏一屏能看到 6 张，够翻一个弃牌区。
           */
          <div
            className="mt-2 grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-1 overflow-y-auto sm:grid-cols-5"
            data-testid="zone-float-cards"
          >
            {props.cards.map((c) => (
              <CardOf key={c.uid} card={c} state={props.state} fluid />
            ))}
          </div>
        ) : (
          <p className="mt-6 mb-6 text-center text-xs text-slate-500">这个区域还没有牌。</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
/** 全部区域 —— 找卡时要挨个翻（D-261）。 */
const ALL_ZONES = [
  'deck',
  'hand',
  'commander',
  'board',
  'spell',
  'cost',
  'graveyard',
  'exile',
  'reveal',
] as const;

/**
 * 按 uid 在**所有区域**里找卡（D-261 / issue #87）。
 *
 * 长按看详情是「看到什么就能查什么」：对手的随从、五区缩略里的弃牌、展示区的卡
 * 都要能查，所以不能只在手牌/随从区里找。
 */
function findAnyCard(state: GameState, uid: string): CardInstance | undefined {
  for (const pid of state.seats) {
    const p = state.players[pid];
    if (!p) continue;
    for (const z of ALL_ZONES) {
      const hit = p.zones[z].find((c) => c.uid === uid);
      if (hit) return hit;
    }
  }
  return undefined;
}

function CardOf(props: {
  card: CardInstance;
  state: GameState;
  sleeping?: boolean;
  selected?: boolean;
  /** 当前不可操作（Era 2026-10-18：不可操作的置灰、不给高亮）。 */
  disabled?: boolean;
  /** 当前可操作（Era 2026-10-18：可操作的对象边框发光）。 */
  glow?: boolean;
  /** 当前是**合法攻击目标**（issue #119 / D-294）—— 与 `glow` 分开，见 `CardTile`。 */
  hittable?: boolean;
  /** 战斗呈现类名（攻击冲撞 / 受击抖动）—— 由调用方按播放中的裁决事件注入。 */
  fxClass?: string;
  /** 区域内紧凑尺寸（格子内卡片比手牌小一号，避免压排 —— D-118 截图实测）。 */
  compact?: boolean;
  /**
   * 宽度由容器决定（D-265）—— 只给**堆叠区浮窗的网格**用。
   *
   * 手牌是固定宽（`w-16 sm:w-20` 横向排），compact 是高度驱动（要父级有确定高度）；
   * 浮窗里的网格两者都不满足：列宽由 `grid-cols-N` 决定、高度由 `aspect-[5/7]` 自己算。
   * 所以这里只做一件事 —— `w-full min-w-0`，尺寸交给网格。
   */
  fluid?: boolean;
  /**
   * 宽度同样交给容器，但语义是「**跟在兄弟后面均分**」（issue #113）。
   *
   * 与 `fluid` 的区别在**来源**，不在结果：
   * - `fluid`：列宽由浮窗网格的 `grid-cols-N` 决定（堆叠区浮窗）；
   * - `fluidWidth`：宽度由**父级 flex 行的 `flex-1` 均分**决定（手牌行）。
   *
   * 两者最终都落到 `w-full min-w-0`，所以刻意分成两个 prop 而不是合并成一个 ——
   * 合并之后「改手牌行布局」与「改浮窗网格」就成了同一处，会互相牵连。
   *
   * 手牌为什么不能固定宽：390px 下手牌区内容宽约 372px，`w-16`（64px）×6 张 +
   * 5 个 `gap-1`（4px）= 404px，横溢出 32px，最后一张被裁在滚动区外（issue #113）。
   */
  fluidWidth?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const def = CARD_POOL[props.card.defId];
  const power = core.unitPower(props.state, CARD_POOL, props.card.uid) ?? def?.power ?? 0;
  /**
   * 局内卡面显示**实际值**（Era 2026-10-21 拍板，D-232）：
   *  - 费用 = 实际支付（随从 −1，`costToPay`），不是卡面印的 `cost`；
   *  - 伤害 = 打脸实际结算（`faceDamageOf`，按**当前**力量分档），只在随从上有意义。
   * 数值算法一律走 core 的导出函数，不在客户端重写一遍口径。
   */
  const payCost = def ? core.costToPay(def) : 0;
  const faceDamage = def?.type === 'minion' ? core.faceDamageOf(def, power) : undefined;
  return (
    // compact（区域/格子内）：高由格子决定、宽按 5:7 反算，不出框（Era 2026-10-18 截图实测）
    <div
      className={
        /*
         * D-264（issue #92）：`w-full min-w-0` 不能省。
         *
         * 原来这里是 `flex h-full min-h-0`，宽度是 shrink-to-fit —— 于是外层按钮的
         * `max-w-full` 变成了「相对自身宽度」的循环引用（百分比基准取自被它撑开的父级），
         * 等于没约束。窄格子里（390px 下五区一格只有 ~63px 内容宽）卡片按高度反算出的
         * 宽度会超过格子，直接压到隔壁区域上、甚至挤出视口。
         */
        props.compact
          ? 'flex h-full min-h-0 w-full min-w-0 items-center justify-center'
          : props.fluid || props.fluidWidth
            ? 'w-full min-w-0'
            : 'w-16 shrink-0 sm:w-20'
      }
      /*
       * D-261（issue #87）：长按看详情的**命中标记**。
       *
       * 挂在包装层而不是卡片按钮上 —— 这样「不能点的卡」（对手的卡、置灰的手牌、
       * 五区缩略）同样能长按；也不受卡片自身的 `disabled` 影响。
       */
      data-card-uid={props.card.uid}
    >
      <CardTile
        name={def?.name ?? props.card.defId}
        cost={payCost}
        power={power}
        faceDamage={faceDamage}
        kind={def?.type ?? 'minion'}
        text={def?.text}
        sleeping={props.sleeping ?? props.card.sleeping}
        frozen={props.card.frozen}
        selected={props.selected}
        disabled={props.disabled}
        glow={props.glow}
        hittable={props.hittable}
        fxClass={props.fxClass}
        fitHeight={props.compact}
        onSelect={props.onClick}
      />
    </div>
  );
}

/**
 * 区域块 —— B2-3：弃牌 / 除外 / 费用 / 法术区恒只显示「区名 + 张数」，
 * 内容点开看**浮窗**（D-265）。费用区按 B2-3 的要求**直接显示数量**。
 *
 * 为什么不是「点开在框里铺开」：区域格子的面积是全桌均分的固定值，而堆叠区的张数
 * 随对局单向增长（弃牌区到 15 张很常见）。把内容放回框里，要么被裁掉、要么把框撑变形——
 * 两种都让玩家读不到信息。所以区域只当「计数 + 入口」，内容一律走浮窗。
 *
 * `content` 决定这个区域**框里放什么**（三态见下）。卡组区刻意是 `count` ——
 * 卡组顺序是隐藏信息，能翻看就等于提前知道下一张抽什么（D-265 顺带修掉的一处泄露）。
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
  /**
   * 框内怎么呈现内容 —— 三态**互斥**（D-265）。
   *
   * - `'cards'`（默认）：直接把卡铺在框里。只给**指挥官区** —— 它是攻击目标，
   *   必须一直看得见，否则「打指挥官 → 扣血 → 血空结束」在界面上没有入口（ADR-0022）。
   * - `'float'`：框里只留区名与张数，内容点开看浮窗。弃牌 / 除外 / 费用 / 法术区。
   * - `'count'`：框里只留张数，**不给看**。只给卡组区 —— 卡组顺序是隐藏信息，
   *   能翻看就等于提前知道下一张抽什么。
   *
   * 用一个枚举而不是两个布尔（`hideCards` + `inspectable`），是因为后者允许
   * 「藏起来又看不见」这种无意义组合，写出第三种区域时很容易配错。
   */
  content?: 'cards' | 'float' | 'count';
  /** 点击区域内某张卡的回调 —— 不传则该区域不可点（默认）。 */
  onCardClick?: (uid: string) => void;
  selected?: boolean;
  /** 区域内的卡当前可操作（发光提示，Era 2026-10-18）—— 如出牌/充能时的我方区域。 */
  glow?: boolean;
  /** 区域内的卡是**合法攻击目标**（issue #119 / D-294）—— 如选中攻击方后的对方指挥官区。 */
  hittable?: boolean;
  /** 拖拽落点标记（B3-1 拖拽）：`dropKey` = 区域级落点（board/cost），`dropUid` = 单卡落点（攻击目标）。 */
  dropKey?: string;
  dropUid?: string;
  /** 拖拽悬停提示：当前拖拽可以落到这里时点亮边框。 */
  highlight?: boolean;
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
  // 浮窗开关（D-265）—— 只有 `content='float'` 的区域能打开。
  const [open, setOpen] = useState(false);
  /** 只有 `content='cards'` 才在框里铺卡；其余两种都只显示张数。 */
  const showCards = (props.content ?? 'cards') === 'cards';
  /**
   * 空区域不给查看 —— 五区大部分时间都是 0 张（法术区、除外区常常整局空着），
   * 让它们也可点只会制造「点出一片空浮窗」的噪音。0 张时退化成纯信息块。
   */
  const inspectable = props.content === 'float' && props.cards.length > 0;
  const shown = showCards ? props.cards : [];

  return (
    // testid 挂在**容器**上而非按钮：这样断言能看到区域本身，
    // 断言的是「这个区域有什么」而不是「这个按钮写了什么」。
    <div
      className={`flex h-full min-h-0 flex-col rounded border p-1 ${
        props.action
          ? 'border-emerald-400 bg-emerald-950/40 ring-2 ring-emerald-400/70'
          : props.highlight
            ? 'border-cyan-400 bg-cyan-950/30 ring-2 ring-cyan-400/70'
            : 'border-slate-700 bg-slate-900/60'
      } ${inspectable ? 'cursor-pointer hover:border-slate-500' : ''}`}
      data-testid={`zone-${props.zone}`}
      {...(props.dropKey ? { 'data-drop': props.dropKey } : {})}
      {...(props.dropUid ? { 'data-drop-uid': props.dropUid } : {})}
      // 整块可点（不只标题行）：390px 下标题只有一行高，手点很容易落到框内空白处。
      {...(inspectable
        ? {
            onClick: () => setOpen(true),
            role: 'button',
            tabIndex: 0,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setOpen(true);
              }
            },
          }
        : {})}
    >
      {/* 标题行恒为纯文本（D-265）：点击由**容器**承担，整块区域都是查看入口。
          可查看时右侧多一个 `›`，告诉玩家「这里有内容、点得开」——
          五区格子只有 60 来像素宽，塞不下「查看」两个字。

          换行而不是截断（issue #129）：390px 下指挥官区标题被压成「指挥...」，
          玩家认不出这是全场唯一掉血就输的区域。`flex-wrap` 让右侧的徽标 / 张数
          整体换到第二行，区名保留完整 —— 宁可多 12px 高，也不要少两个字。 */}
      <div className="flex w-full flex-wrap items-center gap-x-1 text-[10px] leading-tight text-slate-400">
        <span className="min-w-0 break-all" data-testid="zone-label">
          {props.label}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {props.badge ? (
            <span className="font-mono text-rose-300" data-testid={props.badgeTestId}>
              {props.badge}
            </span>
          ) : null}
          <span className="text-slate-200" data-testid="zone-count">
            {props.cards.length}
          </span>
          {inspectable ? (
            <span className="text-slate-500" aria-hidden="true">
              ›
            </span>
          ) : null}
        </span>
      </div>
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
        /*
         * D-264（issue #92）：`overflow-hidden` 是第二道闸。
         *
         * 上面那条 `w-full min-w-0` 解决「卡片自己撑宽」，这一条兜住极端情况
         * （区域窄到连标题都放不下时，卡片仍可能超出一点点）。裁掉一点点边，
         * 好过压住隔壁区域的标题与数值 —— 后者会让玩家读错信息。
         */
        <div className="mt-1 flex min-h-0 flex-1 flex-wrap content-start gap-0.5 overflow-hidden">
          {shown.map((c) => (
            <CardOf
              key={c.uid}
              card={c}
              state={props.state}
              selected={props.selected}
              glow={props.glow}
              hittable={props.hittable}
              compact
              fxClass={props.fxFor?.(c.uid)}
              onClick={props.onCardClick ? () => props.onCardClick?.(c.uid) : undefined}
            />
          ))}
        </div>
      ) : null}
      {/*
        浮窗（D-265）：`fixed` 定位、不参与这一格的布局，所以开合时区域边框不跳。
        放在 ZoneBox 内部而不是提到顶层，是为了「谁的区域、看谁的牌」在代码里就是同一处，
        省掉一个 `{ side, zone }` 的全局状态（那玩意儿一旦与实时 state 不同步，
        打开浮窗看到的就是旧牌）。
      */}
      {open && inspectable ? (
        <ZoneFloat
          label={props.label}
          cards={props.cards}
          state={props.state}
          onClose={() => setOpen(false)}
        />
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
  /** 当前可操作（发光提示）—— 目前只有「我方战斗阶段的随从可被选为攻击方」这一处。 */
  glow?: boolean;
  /** 这一格是**合法攻击目标**（issue #119 / D-294）—— 选中攻击方后的对方随从格。 */
  hittable?: boolean;
  /** 拖拽源标记（data-drag-*，仅可操作时才由调用方传入）。 */
  dragKind?: 'minion';
  dragUid?: string;
  /** 拖拽落点（攻击目标，data-drop-uid）。 */
  dropUid?: string;
  /** 拖拽落点：这一格作为**出牌位置**（D-257，仅我方格子）。 */
  dropSlot?: number;
  /** 格子上的小标签 —— 选位时显示「放这里」/「顶替」。 */
  hint?: string;
  /** 拖拽悬停提示。 */
  highlight?: boolean;
  /** 战斗呈现类名。 */
  fxClass?: string;
  /** 破坏幽灵卡（D-119）：格子已空但破坏动画还在播 —— 渲染淡出中的残影。 */
  ghost?: CardInstance;
  onClick?: () => void;
  /**
   * 整格点击（D-257）。
   *
   * 与 `onClick` 的区别很重要：`onClick` 只挂在**格子里的卡**上，空格子根本没有
   * 可点的节点（原来空格子只有一行「1/2/3」编号）—— 于是「点空位放随从」点了没反应。
   * 选位置**必须**能点空格子，所以把这条挂在最外层 div 上。
   */
  onSlotClick?: () => void;
}): React.JSX.Element {
  return (
    <div
      className={`relative flex h-full min-h-[44px] min-w-0 flex-col items-center justify-center overflow-hidden rounded border border-dashed bg-slate-900/40 p-1 ${
        props.highlight ? 'border-cyan-400 ring-2 ring-cyan-400/70' : 'border-slate-700'
      }`}
      data-testid={`slot-${props.index}`}
      {...(props.onSlotClick ? { onClick: props.onSlotClick } : {})}
      {...(props.dragKind && props.dragUid ? { 'data-drag-kind': props.dragKind, 'data-drag-uid': props.dragUid } : {})}
      {...(props.dropUid ? { 'data-drop-uid': props.dropUid } : {})}
      {...(props.dropSlot === undefined ? {} : { 'data-drop-slot': props.dropSlot })}
    >
      {props.card ? (
        <CardOf
          card={props.card}
          state={props.state}
          sleeping={props.card.sleeping}
          selected={props.selected}
          disabled={props.disabled}
          glow={props.glow}
          hittable={props.hittable}
          compact
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
        <span className="text-[10px] text-slate-500">{props.index + 1}</span>
      )}
      {props.hint ? (
        <span
          className="pointer-events-none absolute inset-x-0 top-0 z-10 mx-auto w-max max-w-full truncate rounded-b bg-cyan-700 px-1 text-[9px] leading-4 text-cyan-50"
          data-testid={`slot-hint-${props.index}`}
        >
          {props.hint}
        </span>
      ) : null}
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
  /**
   * 再来一局（D-309 / #125）—— 系列赛打完后的原地重开。
   *
   * 与 `onNextGame` 并列但不合并：`onNextGame` 只在 BO3 局间出现（比分继续算），
   * 这个只在**整场结束**后出现（比分归零、双方都得点）。两者不会同时在场。
   */
  onRematch: () => void;
  /**
   * 收起态（issue #154）—— 结算现在是**覆盖层**，让玩家能把它收起去看战报，
   * 收起时保留「查看本局结算 / 返回主界面」两个出口。
   */
  collapsed: boolean;
  onCollapseChange: (collapsed: boolean) => void;
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
  /*
   * 「再来一局」的三种形态（D-309 / #125）：
   *  - 只在**系列赛打完**（`phase === 'ended'`）出现 —— BO3 局间仍走上面那颗「开始第 N 局」，
   *    两个动作语义不同（那个比分继续算，这个比分归零）；
   *  - 人机房的 AI 不会点按钮，玩家点一次即开；
   *  - 联机必须双方都点，所以要能分辨「我点了在等」与「对手点了在等我」两种中间态。
   */
  const solo = room?.solo === true;
  const rematchVotes = room?.rematchVotes ?? [];
  const iVoted = rematchVotes.includes(props.me);
  const foeVoted = rematchVotes.some((id) => id !== props.me);
  const foeSeat = room?.seats.find((s) => s !== null && s.playerId !== props.me) ?? null;
  const canRematch = room?.phase === 'ended';
  /*
   * 对手还在不在 —— AI 恒在；联机看席位是否存在且未断线。
   * 席位为 `null`（已离开 / 宽限期满被回收）与 `connected === false`（掉线中）
   * 对玩家是同一件事：此刻开不了局，按钮就该是灰的并说明原因。
   */
  const foeReady = solo || (foeSeat !== null && foeSeat.connected);
  /**
   * 成因行（P-02 / D-238）—— 同一句「败北」有四种成因（被打死 / 认输 / 对手掉线 / 40 轮），
   * 不给成因等于让玩家靠自己回忆。`endReason` 已经在状态里，这里只是翻译成视角文案。
   */
  const reasonText = endReasonText(props.state.endReason, draw, (seriesWon ?? won) === true);

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

  /*
   * 本局摘要（issue #154）—— 结算页原来只有四行字（败北 / 对局结束 / 成因 / 返回），
   * 血量与回合数都不在。回放入口置灰（D-183）、战报才是唯一复盘手段，
   * 所以结算页必须自己回答「这局打了多久、双方最后各剩多少」。
   * 血量直接取 `players[].health`（ADR-0024 的 10 血口径），**不在这里重算任何规则**。
   */
  const foeId = Object.keys(props.state.players).find((id) => id !== props.me);
  const myHealth = props.state.players[props.me]?.health ?? 0;
  const foeHealth = foeId ? (props.state.players[foeId]?.health ?? 0) : 0;

  /*
   * 收起态：结算让开，牌桌与战报回到可读状态，但两个出口不能丢
   * —— 收起来之后玩家仍然要能「返回主界面」，否则等于把人锁在牌桌里。
   */
  if (props.collapsed) {
    return (
      <div
        className="fixed inset-x-0 bottom-2 z-[75] flex justify-center gap-2 px-2"
        data-testid="result-bar"
      >
        <button
          type="button"
          className="rounded bg-slate-700 px-4 py-2 text-xs text-slate-100 shadow-lg"
          onClick={() => props.onCollapseChange(false)}
          data-testid="result-reopen"
        >
          查看本局结算
        </button>
        <button
          type="button"
          className="rounded border border-slate-600 bg-slate-800 px-4 py-2 text-xs text-slate-300 shadow-lg"
          onClick={props.onBack}
          data-testid="result-back"
        >
          返回主界面
        </button>
      </div>
    );
  }

  return (
    /*
     * 覆盖层（issue #154）—— 不再 `return` 掉整块牌桌。
     *
     * `sm:right-40 md:right-56` **就是右侧战报列的宽度**（`aside` 的 `sm:w-40 md:w-56`）：
     * 容器缩到战报列左边，遮罩随之只压暗牌桌，战报既不被压暗、也不被挡住滚动。
     * 窄屏没有常驻右列（战报是抽屉，默认收起），所以那里仍是全屏遮罩。
     */
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center p-3 sm:right-40 sm:p-4 md:right-56"
      data-testid="result-overlay"
    >
      <div className="absolute inset-0 bg-slate-950/72" aria-hidden="true" />
      <div
        className="relative flex max-h-full w-full max-w-sm flex-col items-center gap-3 overflow-y-auto rounded-xl border border-slate-600 bg-slate-900/95 p-5 text-center shadow-2xl"
        data-testid="result-card"
      >
        {/* 收起入口放在卡片右上角：它是「想让开」的动作，不该和「返回主界面」混在一排 */}
        <button
          type="button"
          className="absolute right-2 top-2 rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800"
          onClick={() => props.onCollapseChange(true)}
          data-testid="result-collapse"
        >
          收起
        </button>
        <p
          className={`text-4xl font-bold ${draw ? 'text-slate-200' : (seriesWon ?? won) ? 'text-amber-300' : 'text-slate-300'}`}
          data-testid="game-result"
        >
          {title}
        </p>
        <p className="text-sm text-slate-400" data-testid="series-score">
          {room && room.format === 'bo3'
            ? `BO3 · 第 ${Math.max(1, room.gameNo)} 局结束 · 比分 我 ${myWins} : ${foeWins} 对手`
            : '对局结束'}
        </p>
        <div className="flex flex-col items-center gap-0.5">
          <p className="text-xs text-slate-300" data-testid="result-turns">
            共 {props.state.turn} 回合
          </p>
          <p className="text-xs text-slate-300" data-testid="result-hp">
            我方 {myHealth} · 对手 {foeHealth}
          </p>
          {/* 成因行（P-02）：说清「怎么输的 / 怎么赢的」，避免同一句「败北」有四种含义 */}
          {reasonText ? (
            <p className="text-xs text-slate-500" data-testid="end-reason">
              {reasonText}
            </p>
          ) : null}
        </div>
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
            <p className="text-xs text-slate-400" data-testid="wait-next">
              等待房主开始第 {nextGameNo} 局…
            </p>
          )
        ) : null}
        {/* 再来一局（D-309 / #125）—— 结算页的主按钮；「返回主界面」退为次按钮。 */}
        {canRematch ? (
          foeReady ? (
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                // 已经投过票（且不是人机房）→ 现在只是「等对手」，禁用防连点；
                // 对手点了任何一下都会把界面推走，不需要本地做「打开中」的中间态。
                disabled={iVoted && !solo}
                className={`rounded px-6 py-2 text-sm ${
                  iVoted && !solo
                    ? 'cursor-wait bg-slate-700 text-slate-300'
                    : 'bg-emerald-700 font-semibold text-white hover:bg-emerald-600'
                }`}
                onClick={props.onRematch}
                data-testid="rematch"
              >
                {iVoted && !solo ? '等待对手确认…' : '再来一局'}
              </button>
              {foeVoted && !iVoted ? (
                <p className="text-xs text-emerald-300" data-testid="rematch-invite">
                  对手想再来一局
                </p>
              ) : null}
              {iVoted && !solo ? (
                <p className="text-xs text-slate-400" data-testid="rematch-wait">
                  对手点一下就能立刻开局
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <button
                type="button"
                disabled
                className="cursor-not-allowed rounded border border-slate-700 bg-slate-800/40 px-6 py-2 text-sm text-slate-500"
                data-testid="rematch"
              >
                再来一局
              </button>
              <p className="text-xs text-amber-300" data-testid="rematch-hint">
                对手已离开，无法再来一局
              </p>
            </div>
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
        {/*
          回放入口（D-183）—— Era 2026-10-20：**先置灰，但正常记录**。
          公网走隧道、每月流量有限，开放观看等于每次复盘都从服务器拉一份 `replay.json`。
          服务端记录链路不受影响（`app/replays/` 照常落盘），要开放只改
          `features.ts` 的 `REPLAY_VIEW_ENABLED`。
          按钮位置定在结算面板：看回放的人一定是刚打完的人，且不需要额外的列表页。
        */}
        <button
          type="button"
          disabled={!REPLAY_VIEW_ENABLED}
          title={
            REPLAY_VIEW_ENABLED
              ? '查看本局回放'
              : '回放观看暂未开放（节省公网流量）；对局记录已在服务端保存'
          }
          className="rounded border border-slate-600 bg-slate-800 px-6 py-2 text-sm text-slate-300 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800/40 disabled:text-slate-500"
          data-testid="replay-view"
        >
          查看回放{REPLAY_VIEW_ENABLED ? '' : '（暂未开放）'}
        </button>
      </div>
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
  /*
   * 统领 Ⅰ 的子效果文案 —— 键是**序号**，门槛数字从 `BLADE_EXILE_TIERS` 取，
   * 不在这里重写一遍。上一版把「3 档 / 5 档 / 9 档」写死在文案里，
   * 门槛一前移就变成「菜单写 9、实装 7」（#138 / D-290）。
   */
  const SUB_LABEL: Readonly<Record<string, string>> = {
    tier1: `≥${BLADE_EXILE_TIERS[0]} 个：从弃牌区召唤随从（力量 ≤ 炎刃数）`,
    tier2: `≥${BLADE_EXILE_TIERS[1]} 个：一个己方随从本回合力量 +1`,
    tier3: `≥${BLADE_EXILE_TIERS[2]} 个：破坏一个随从（力量 ≤ 炎刃数，可选对方场上）`,
    tier4: `≥${BLADE_EXILE_TIERS[3]} 个：一个己方随从本回合对指挥官伤害 +1`,
    tier5: `≥${BLADE_EXILE_TIERS[4]} 个：一个己方随从一回合一次攻击后重置`,
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

  /**
   * 防连点（D-260 / issue #88）—— 一次回答只发一次 `effect:choose`。
   *
   * 面板要等服务端回包才消失；公网隧道 RTT 是秒级，这期间连点会补发第二个 Intent。
   * 那时服务端已经没有待回答的选择了，只能回 `INVALID_CHOICE`（Era 现场就是反复点同一张卡）。
   * 用时间窗而不是 `disabled`：服务端真拒绝时（选择还在）按钮不能永久卡死。
   */
  const answeredAtRef = useRef<{ opt: string; at: number }>({ opt: '', at: 0 });
  const answer = (opt: string): void => {
    const now = Date.now();
    // ⚠️ 只拦「同一个选项」的连点：多选类（焚典 / 守夜人）需要连续点**不同**的卡，
    // 一并限流会把正常的多选吃掉。
    const last = answeredAtRef.current;
    if (opt === last.opt && now - last.at < 800) return;
    answeredAtRef.current = { opt, at: now };
    props.onChoose(opt);
  };

  // uid 选项 → 反查卡定义渲染小卡；子效果选项 → 文案按钮
  const findCard = (uid: string): CardInstance | undefined =>
    Object.values(props.state.players)
      .flatMap((p) => Object.values(p.zones).flat())
      .find((x) => x.uid === uid);

  // 候选跨了双方时标出「我方 / 敌方」（issue #105）—— 镜像对局里同名随从靠卡名分不清
  const sideLabels = choiceSideLabels(props.state, choice);

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
                  onClick={() => answer(opt)}
                  data-testid={`choice-${opt}`}
                >
                  {SUB_LABEL[opt]}
                </button>
              );
            }
            const inst = findCard(opt);
            const def = inst ? CARD_POOL[inst.defId] : undefined;
            const side = sideLabels[opt];
            return (
              <button
                key={opt}
                type="button"
                className="w-16 rounded border border-slate-600 bg-slate-800 p-1 text-center hover:border-emerald-400"
                onClick={() => answer(opt)}
                data-testid={`choice-card`}
              >
                {side ? (
                  <span
                    className={`block text-[9px] leading-tight ${
                      side === '我方' ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                    data-testid="choice-side"
                  >
                    {side}
                  </span>
                ) : null}
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
          onClick={() => answer('pass')}
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
}): React.JSX.Element {
  return (
    <div
      className="flex h-full min-h-0 flex-col rounded border border-dashed border-slate-600 bg-slate-900/40 p-1"
      data-testid="zone-reveal"
    >
      <span className="text-[10px] text-slate-400">展示区</span>
      <div className="mt-1 flex min-h-0 flex-1 flex-wrap content-start gap-0.5 overflow-y-auto">
        {props.cards.map((rc) => {
          const inst: CardInstance = { uid: rc.uid, defId: rc.defId };
          return (
            <CardOf
              key={rc.uid}
              card={inst}
              state={props.state}
              compact
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
   * 卡组（D-141 / D-184）—— 准备页可改，准备后锁定（服务端同样只接受未开局）。
   *
   * 选择存本机；发给服务端的是**一整套**：30 个 defId + 1 位指挥官。
   * 没有「阵营默认」了，列表里恒有三套基础卡组兜底，所以永远能发出一套确定的选择。
   */
  const [options] = useState(listSelectionOptions);
  // 与主界面同口径：优先恢复本机记住的那一套（哪怕它已不满 30 张，那正是要提示的）。
  const [deckValue, setDeckValue] = useState(() => {
    const saved = loadActiveDeckId();
    if (options.some((o) => o.value === saved)) return saved;
    return options.find((o) => o.complete)?.value ?? options[0]?.value ?? '';
  });
  const chosen = options.find((o) => o.value === deckValue) ?? null;
  const play = chosen?.complete ? chosen : selectionForPlay();
  const pickDeck = (value: string): void => {
    setDeckValue(value);
    saveActiveDeckId(value);
    const o = options.find((x) => x.value === value);
    if (o?.complete) setDeck(o.deck, o.commander);
    else {
      // 选了不完整的一套 → 实际用的是兜底那套，服务端要收到与界面一致的东西（D-173）。
      const fb = selectionForPlay();
      setDeck(fb.deck, fb.commander);
    }
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
      {/* H18：赛制与回合时限是这间房的约定，开局前就要看得见（对手也要知道） */}
      <p className="text-xs text-slate-400" data-testid="room-rules">
        {room?.format === 'bo3' ? 'BO3 三局两胜' : 'BO1 一局定胜负'} · 每回合{' '}
        {turnTimeoutLabel(room?.turnTimeoutMs ?? TURN_TIMEOUT_MS)}
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
      {/* 卡组（D-141 / D-184）：准备前可换；准备后锁定，避免开局瞬间还在改 */}
      {!meReady && options.length > 0 ? (
        <label className="block w-full max-w-xs text-left">
          <span className="text-xs text-slate-400">我的卡组（卡组自带指挥官）</span>
          <select
            className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            value={deckValue}
            onChange={(e) => pickDeck(e.target.value)}
            data-testid="waiting-deck"
          >
            {options.map((o) => {
              const n = o.deck.length;
              return (
                <option key={o.value} value={o.value} disabled={!o.complete}>
                  {o.label}（{n}/{MAIN_DECK_SIZE} 张{o.complete ? '' : '，未完成'}）·{' '}
                  {CARD_POOL[o.commander]?.name ?? ''}
                </option>
              );
            })}
          </select>
          <p className="mt-1 text-[11px] text-slate-500" data-testid="waiting-deck-current">
            本局使用：{play.label} · 指挥官 {CARD_POOL[play.commander]?.name ?? play.commander}
          </p>
          {/* 选了但不足 30 张 → 上面那句已经说了实际用哪套，这里补一句**为什么**，
              否则下拉里还显示那套被选中，玩家会以为是它（D-173）。 */}
          {chosen && !chosen.complete ? (
            <p className="mt-1 text-[11px] text-amber-300" data-testid="waiting-deck-incomplete">
              所选卡组不足 {MAIN_DECK_SIZE} 张，本局使用「{play.label}」
            </p>
          ) : null}
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
  const { room, state, me, foe, turnDeadline, log, notice, fx, revealed, turnPending, dismiss } =
    session;
  // 手牌选中 —— Era 2026-10-18：**非多目标场景的选中必须排他**，任何时候最多一张手牌高亮。
  // （充能规则上允许任意数量（X-2），但协议支持逐张发，多张充能 = 连续多次单张操作。）
  const [picked, setPicked] = useState<string | null>(null);
  const [attacker, setAttacker] = useState<string | null>(null);
  /**
   * 认输二次确认（D-147；D-295 改为居中浮层）。
   *
   * `concede` 规则（docs/06 A3-4「随时认输」）早就实现了，但一直没有 UI 入口 ——
   * 玩家想认输只能点「离开」，而在 BO3 里离开 = 判负**整个系列赛**，差别很大。
   * 认输不可撤销，故做成两段式：第一次点打开确认浮层，浮层里点「确认认输」才真的发。
   */
  const [concedeArmed, setConcedeArmed] = useState(false);
  /** 对局已经结束就收起确认浮层 —— 否则结果面板上会一直压着一层「要不要认输」。 */
  const gameEnded = state !== null && (state.winner !== null || state.draw);
  useEffect(() => {
    if (concedeArmed && gameEnded) setConcedeArmed(false);
  }, [concedeArmed, gameEnded]);
  /** 详情浮层里正在查看的卡（Era 2026-10-18：卡牌携带效果必须可查看）。 */
  const [detailCard, setDetailCard] = useState<CardInstance | null>(null);
  /**
   * 换牌多选（D-259 之后不再需要「进入换牌模式」这个状态）。
   *
   * 开局就停在换牌阶段，手牌默认就是多选题 —— 少一次「点换牌按钮才进模式」的步骤，
   * 也少一个「模式开着但阶段已过」的失配态。换牌是**多目标**操作（returns 数组），
   * 这不影响非多目标场景的排他纪律（Era 2026-10-18）。
   */
  const [mulliganPicks, setMulliganPicks] = useState<string[]>([]);
  /**
   * 结算覆盖层的收起态（issue #154）—— 收起后露出完整牌桌与战报。
   *
   * 它描述的只是「这一局的结算让不让开」，所以下一局一开始必须复位
   * —— 否则 BO3 第二局会莫名其妙没有结算面板（牌桌正常、结算永不出现）。
   */
  const [resultCollapsed, setResultCollapsed] = useState(false);
  useEffect(() => {
    if (!gameEnded) setResultCollapsed(false);
  }, [gameEnded]);
  const [now, setNow] = useState(() => Date.now());

  /**
   * 新手引导（P-03）—— 只在**第一次进入对战桌**时弹，看过即写 localStorage。
   *
   * 初始化读 localStorage 是安全的（与 HomeScreen 的昵称同一做法）；
   * E2E 通过 `addInitScript` 预置标记，避免浮层挡住每一步点击。
   */
  const [showIntro, setShowIntro] = useState(() => {
    try {
      return localStorage.getItem(INTRO_SEEN_KEY) !== '1';
    } catch {
      return false;
    }
  });
  /** 音效开关（P-06）：默认开，选择存本机。 */
  const [sfxOn, setSfxOn] = useState(() => !isSfxMuted());
  /**
   * 移动端日志抽屉（T-02）。
   *
   * 390px 竖屏下原来的右侧日志列是 `hidden sm:flex`，**整列消失** ——
   * 战报在手机上根本看不到。桌面(≥640px)仍是常驻列，窄屏改为按钮展开的抽屉。
   */
  const [logOpen, setLogOpen] = useState(false);

  /**
   * 出牌的两段选择（D-257，Era 2026-10-21）。
   *
   * `placing`：已选随从、正在选放到第几格（点格子后可能还要选费用）。
   * `payPicker`：正在选「用哪几张费用卡支付」。
   *
   * 为什么是两段而不是一个大面板：绝大多数出牌「费用区正好够付、格子也空着」，
   * 那种情况必须保持「点出牌 → 点格子」两步；只有真的可挑（费用区多了 / 要顶替）
   * 才让玩家做决定。
   */
  const [placing, setPlacing] = useState<string | null>(null);
  const [payPicker, setPayPicker] = useState<{
    uid: string;
    slot?: number;
    pay: number;
    picks: string[];
  } | null>(null);

  /**
   * 拖拽状态（B3-1 / Era 2026-10-18）。
   *
   * ⚠️ **所有 hook 必须放在 early return 之前** —— 本组件有「等待房间」的提前返回，
   * hook 若写在返回之后，开局后 hook 数量会变多，React 直接崩溃
   * （Rendered more hooks than during the previous render，2026-10-18 实测踩过）。
   */
  const dragRef = useRef<{ uid: string; kind: 'hand' | 'minion'; startX: number; startY: number; active: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  /**
   * 长按看详情（D-261 / issue #87）的计时器 —— 手指按住不动 400ms 即打开详情浮层。
   *
   * ⚠️ 与拖拽共用同一次 pointerdown：移动超过阈值就取消长按（那是拖拽），
   * 长按触发后要反过来压掉随后的 click，否则「长按看卡」会顺带把手牌选中/出牌。
   */
  const longPressRef = useRef<{ uid: string; timer: number; x: number; y: number } | null>(null);
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
   *
   * T-04：判据已抽到 `selectors.ts`（纯函数、可单测），组件里只留取值 ——
   * 原来这几条散在组件体内，3849 行零单测，「什么阶段能点」改错了没人拦得住。
   * 仍是**状态直读**（阶段 / 回合归属 / 休眠都写在快照里），不是本地规则推算。
   */
  const act = state && me ? actionability(state, me, now) : null;
  const canPickHand = act?.canPickHand ?? false;
  const canBattle = act?.canBattle ?? false;
  const mulliganOpen = act?.mulliganOpen ?? false;

  // 离开可操作阶段时清掉残留选中 —— 否则置灰后取消不了，卡在「看着被选中却动不了」。
  useEffect(() => {
    if (!canPickHand) setPicked(null);
  }, [canPickHand]);
  useEffect(() => {
    if (!canBattle) setAttacker(null);
  }, [canBattle]);
  // 换牌阶段一结束（自己确认 / 双方都确认 / 超时兜底）就清掉未提交的选择。
  useEffect(() => {
    if (!mulliganOpen && mulliganPicks.length > 0) setMulliganPicks([]);
  }, [mulliganOpen, mulliganPicks.length]);
  // 离开主要阶段就取消没做完的出牌选择（D-257）—— 否则过回合后还挂着「选位置」。
  useEffect(() => {
    if (state?.phase !== 'main') {
      setPlacing(null);
      setPayPicker(null);
    }
  }, [state?.phase]);

  if (!me || !room) {
    return <p className="p-4 text-slate-400">请从主界面创建或加入房间。</p>;
  }
  if (!state || !state.started) {
    return <WaitingRoom session={session} />;
  }

  /*
   * 对局已结束（含对手中途离开由系统代认输）—— **不再在这里 return 掉整块牌桌**（issue #154）。
   *
   * 旧写法直接 `return <GameOverPanel/>`，代价是：右侧战报 DOM 一起消失
   * （`[data-testid="log"]` 取不到），而回放入口置灰（D-183）之后，
   * 战报就是唯一的复盘手段 —— 打完一局就没法回看发生了什么。
   * 现在结算以**覆盖层**形式叠在牌桌上（见渲染末尾），牌桌与战报继续留在 DOM 里。
   *
   * ⚠️ 覆盖层仍要排在「等待对手加入」之前判定（Era 2026-10-18：一方离开后另一方卡在空白页）：
   *    对手离场后 `state.players` 里仍有其数据、但席位已空，先判对手缺失会把结算永远挡住。
   */
  const over = state.winner !== null || state.draw;

  const mine: PlayerState | undefined = me ? state.players[me] : undefined;
  const theirs: PlayerState | undefined = foe ? state.players[foe] : undefined;
  if (!mine || !theirs) {
    /*
     * 终局时数据也不可能缺 —— 但要留兜底：真缺了也必须给结算与出口，
     * 而不是把玩家按在「等待对手加入…」上（这正是 D-122 修过的那类卡死）。
     */
    if (over) {
      return (
        <GameOverPanel
          state={state}
          me={me}
          room={room}
          onBack={session.leave}
          onNextGame={session.nextGame}
          onRematch={session.rematch}
          collapsed={resultCollapsed}
          onCollapseChange={setResultCollapsed}
        />
      );
    }
    return <p className="p-4 text-slate-400">等待对手加入…</p>;
  }

  /**
   * 对手连线状态（PM-03 / AR-23 / D-233）：`connected` 一直存在协议里，
   * 但界面从未消费 —— 于是「对手掉线 / 对手在想 / 自己卡了」在玩家眼里无法区分。
   * 宽限期内提示可重连，到期由服务端按「已离开」收尾（判负本局与系列赛）。
   */
  const foeSeat = room.seats.find((s) => s !== null && s.playerId === foe);
  const foeOffline = foeSeat !== null && foeSeat !== undefined && !foeSeat.connected;
  const graceSeconds = Math.round(RECONNECT_GRACE_MS / 1000);

  /*
   * early return 之后 state 与 me 都非空，`act` 必然算得出来 —— 这里断言一次，
   * 避免把「不可能为 null」这件事传染给下面十几个使用点。
   */
  /** 断线横幅文案（D-255）：`null` = 不挂横幅。 */
  const banner = linkBannerText(session.link);

  const a = act as Actionability;
  const myTurn = a.myTurn;
  const choiceOpen = a.choiceOpen;
  const canDraw = a.canDraw;
  const canCommanderAttack = a.canCommanderAttack;
  const canRevealAttack = a.canRevealAttack;

  // ⚠️ 客户端时钟与服务端未必同步，这里的倒计时是**示意**；权威判定在服务端（ADR-0017）。
  const remain = turnDeadline ? Math.max(0, Math.ceil((turnDeadline - now) / 1000)) : null;
  /**
   * 换牌阶段的剩余秒数（D-267）。
   *
   * 服务端在换牌阶段把 `turnDeadline` 填成**换牌截止时刻**（此前填的是回合计时器的
   * `deadlineAt`，而换牌时那个计时器是 clear 状态 → 顶栏「计时 —」）。
   * 到点由服务端替未确认方提交「不换牌」，客户端这里只负责把这句话说清楚。
   */
  const mulliganLeft = state.phase === 'mulligan' ? remain : null;
  /** 换牌窗口已耗尽 —— 界面进入「等开局」状态，按钮置灰（服务端马上会推进）。 */
  const mulliganExpired = state.phase === 'mulligan' && mulliganLeft !== null && mulliganLeft <= 0;

  /**
   * 当前阶段该做什么（D-258）+ 顶栏归属文案。
   *
   * Era 2026-10-21：「过回合时充能阶段显示好像不太明显」——
   * 阶段进度条只回答「我在哪」，没有回答「我现在该做什么」。
   *
   * 判据已抽到 `selectors.ts` 的 `turnGuidance`（纯函数、可单测），因为它在 D-268 上
   * 踩过一个坑：逐条播放事件时，回合边界中间那一帧「阶段已充能、席位还没换」
   * 会让结束回合的人看到「你的回合 · 充能阶段…」。详见该函数注释。
   */
  const guide = turnGuidance(state, me, turnPending);
  const phaseHint = choiceOpen
    ? ''
    : state.phase === 'mulligan'
      ? mulliganOpen
        ? mulliganExpired
          ? '换牌时间到，正在开局…'
          : `开局换牌：点选不想留的手牌（可多选）→ 出现「确认换牌」；不想换就直接点「不换牌」${
              mulliganLeft === null ? '' : `（剩余 ${mulliganLeft} 秒，到点自动不换牌开局）`
            }`
        : '你已确认，等待对手完成换牌…'
      : guide.hint;

  /**
   * 指挥官攻击也走「点自己 → 点目标」（D-258，Era 2026-10-21 明确要求）。
   *
   * `attacker` 仍然是 uid，指挥官与随从共用一个变量：两者 uid 不会相同，
   * 且「选中谁」在界面上是同一件事。点到敌方目标时按 `commanderAttacking` 分派 Intent。
   */
  const myCommanderUid = mine.zones.commander[0]?.uid ?? null;
  const commanderAttacking = attacker !== null && attacker === myCommanderUid;

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

  /**
   * 按格子取随从（D-257）。
   *
   * 优先用卡上的 `slot`，老快照（卡上没有 slot 字段）按数组下标兜底 ——
   * 两条路径都要对，否则重连到一个旧快照就会两张卡挤在一格。
   */
  const atSlot = (zone: readonly CardInstance[], i: number): CardInstance | undefined =>
    zone.find((c, idx) => (c.slot ?? idx) === i);

  /** 本次出牌要支付几张 —— 与服务端同一口径（随从减 1，再吃「下一张随从减费」）。 */
  const payFor = (card: CardInstance): number => {
    const def = CARD_POOL[card.defId];
    if (!def) return 0;
    const base = core.costToPay(def);
    return def.type === 'minion' ? Math.max(0, base - mine.nextMinionDiscount) : base;
  };

  /**
   * 出牌第二步：位置已定（法术为 `undefined`）→ 决定要不要让玩家选费用。
   *
   * 费用区**正好只有该付的张数**时不弹选择（没得挑，多一次点击只是噪音）；
   * 只有「费用区比该付的多」时才需要玩家决定牺牲哪几张。
   */
  const commitPlay = (uid: string, slot?: number): void => {
    const card = mine.zones.hand.find((x) => x.uid === uid);
    if (!card) return;
    const pay = payFor(card);
    if (pay > 0 && mine.zones.cost.length > pay) {
      setPayPicker({
        uid,
        ...(slot === undefined ? {} : { slot }),
        pay,
        // 预选前 pay 张 = 旧行为；玩家可以直接确认，也可以改成别的组合。
        picks: mine.zones.cost.slice(0, pay).map((x) => x.uid),
      });
      // 位置已经定了 —— 收起「选位置」提示，否则它会和支付面板同时挂在屏幕上。
      setPlacing(null);
      return;
    }
    session.play(uid, slot === undefined ? undefined : { slot });
    setPicked(null);
    setPlacing(null);
  };

  /** 点「出牌」：随从先选格子（选完再决定费用），法术直接走支付。 */
  const startPlay = (uid: string): void => {
    const card = mine.zones.hand.find((x) => x.uid === uid);
    if (!card) return;
    if (CARD_POOL[card.defId]?.type === 'minion') {
      setPlacing(uid);
      setPicked(null);
      return;
    }
    commitPlay(uid);
  };

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
   * 正在拖的手牌属于哪种牌（issue #108）—— 决定**哪个区域该高亮**。
   *
   * 以前无论拖什么牌都只亮随从区，等于在暗示「法术也往这儿拖」，
   * 而法术拖到随从格会被规则拒绝。现在：随从亮随从区、法术/设置法术亮法术区。
   */
  const draggingHandType = (() => {
    if (dragging?.kind !== 'hand') return undefined;
    const card = mine.zones.hand.find((x) => x.uid === dragging.uid);
    return card ? CARD_POOL[card.defId]?.type : undefined;
  })();

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
      // 手指动了就是拖拽，不是长按（D-261）—— 两个手势共用同一次 pointerdown。
      cancelLongPress();
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
      ?.closest<HTMLElement>('[data-drop],[data-drop-uid],[data-drop-slot]');
    if (!hit) return; // 拖到无效区域 = 取消（B3-4）
    /*
     * 落点语义住在 `selectors.dragDropIntent`（issue #108）—— 原来这段是手写 DOM 分支，
     * 组合情况没有单测，「法术拖到随从格」因此一直带着非法 slot 去换一句报错。
     * ⚠️ `closest()` 命中的是**最近**的标记节点：拖到格子上时命中的是格子本身
     * （只有 `data-drop-slot`，没有 `data-drop="board"`），两种标记都算「落在随从区」。
     */
    const card = d.kind === 'hand' ? mine.zones.hand.find((x) => x.uid === d.uid) : undefined;
    const action = dragDropIntent({
      dragging: d.kind,
      phase: state.phase,
      ...(card ? { cardType: CARD_POOL[card.defId]?.type } : {}),
      ...(hit.dataset['drop'] === undefined ? {} : { drop: hit.dataset['drop'] }),
      ...(hit.dataset['dropSlot'] === undefined ? {} : { slot: hit.dataset['dropSlot'] }),
      ...(hit.dataset['dropUid'] === undefined ? {} : { targetUid: hit.dataset['dropUid'] }),
    });
    if (action.kind === 'play') commitPlay(d.uid, action.slot);
    else if (action.kind === 'charge') session.charge([d.uid]);
    else if (action.kind === 'attack') session.attack(d.uid, action.targetUid);
  };

  /* ---------------- 长按看详情（D-261 / issue #87） ----------------
   * Era：「卡片详情的问号按钮太难点了，需要修改方案」。
   *
   * 取代原来右上角那个 16px 的「?」：整张卡都是命中区（手指友好），按住 400ms 打开详情。
   * 与拖拽共用同一次 pointerdown —— 手指移动超过阈值就取消长按、转为拖拽；
   * 长按真的触发了就压掉随后补发的 click（否则看详情会顺带选中手牌）。
   * 桌面另有右键（onContextMenu）与「选中后操作条上的详情按钮」两条入口。
   */
  const LONG_PRESS_MS = 400;
  /** 按住时容许的抖动 —— 超过就当作拖拽（比拖拽阈值略大，避免边界上互相打架）。 */
  const LONG_PRESS_SLOP = 10;

  const onLongPressMove = (e: PointerEvent): void => {
    const lp = longPressRef.current;
    if (!lp) return;
    if (Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > LONG_PRESS_SLOP) cancelLongPress();
  };

  const cancelLongPress = (): void => {
    const lp = longPressRef.current;
    if (!lp) return;
    clearTimeout(lp.timer);
    longPressRef.current = null;
    window.removeEventListener('pointermove', onLongPressMove);
    window.removeEventListener('pointerup', cancelLongPress);
    window.removeEventListener('pointercancel', cancelLongPress);
  };

  const beginLongPress = (uid: string, x: number, y: number): void => {
    cancelLongPress();
    const timer = window.setTimeout(() => {
      longPressRef.current = null;
      window.removeEventListener('pointermove', onLongPressMove);
      window.removeEventListener('pointerup', cancelLongPress);
      window.removeEventListener('pointercancel', cancelLongPress);
      const card = findAnyCard(state, uid);
      if (!card) return;
      // 长按已经消费掉这次按压 —— 压掉随后补发的 click。
      // 不定时清零会吃掉下一次真实点击（拖拽那段踩过同样的坑）。
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 800);
      dragRef.current = null;
      setDragging(null);
      setDragPos(null);
      openDetail(card);
    }, LONG_PRESS_MS);
    longPressRef.current = { uid, timer, x, y };
    window.addEventListener('pointermove', onLongPressMove);
    window.addEventListener('pointerup', cancelLongPress);
    window.addEventListener('pointercancel', cancelLongPress);
  };

  /** 右键 = 看详情（桌面主入口；长按在鼠标上按 400ms 太反直觉）。 */
  const onTableContextMenu = (e: React.MouseEvent): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-uid]');
    const uid = el?.dataset['cardUid'];
    if (!uid) return;
    const card = findAnyCard(state, uid);
    if (!card) return;
    e.preventDefault();
    cancelLongPress();
    openDetail(card);
  };

  /** 事件委托：拖拽源以 data-drag-* 标记挂在卡容器上（仅可操作时才挂）。 */
  const onTablePointerDown = (e: React.PointerEvent): void => {
    // 只认主键（左键 / 单指）：右键交给 onContextMenu，避免右键也起一个长按计时器。
    if (e.button !== 0) return;
    // 长按看详情挂在**所有**卡上（含对手的卡与五区缩略），与能不能操作无关。
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('[data-card-uid]');
    const cardUid = cardEl?.dataset['cardUid'];
    if (cardUid) beginLongPress(cardUid, e.clientX, e.clientY);

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
    <div
      className="flex h-dvh flex-col gap-1 bg-[#151b26] p-1 sm:p-2"
      onPointerDown={onTablePointerDown}
      onContextMenu={onTableContextMenu}
    >
      {/*
        断线横幅（D-255）—— 与主界面同一类问题：socket 断开后 `emit` 静默排队，
        出牌、推进、攻击全都「点了没反应」，玩家只会以为游戏卡死。
        对战桌上原本完全没有连接态提示，所以这一条必须常显在最上层。
      */}
      {banner !== null ? (
        <p
          className="fixed inset-x-0 top-0 z-[80] bg-amber-600 px-3 py-1 text-center text-xs text-black"
          data-testid="conn-banner"
          role="status"
        >
          {banner}
        </p>
      ) : null}
      {/* 阶段进度条常显（Era 2026-10-18：过阶段反馈差）—— 六阶段一排，当前阶段高亮。
          与横幅分工：进度条回答「我在哪」，横幅回答「刚发生了什么」。
          换牌（D-259）不属于任何回合、不在 `PHASE_ORDER` 里，单独补一枚前置标签 ——
          否则开局时六个格全灰，玩家会以为对局没开始。 */}
      <nav className="flex items-center justify-center gap-1" data-testid="phase-track">
        {state.phase === 'mulligan' ? (
          <span
            className="rounded-full bg-violet-500 px-2 py-0.5 text-[10px] font-medium text-slate-950 sm:text-[11px]"
            data-testid="phase-track-mulligan"
          >
            {PHASE_LABEL.mulligan}
          </span>
        ) : null}
        {core.PHASE_ORDER.map((ph) => (
          <span
            key={ph}
            className={`rounded-full px-2 py-0.5 text-[10px] sm:text-[11px] ${
              ph === state.phase
                ? 'bg-amber-500 font-medium text-slate-950'
                : 'border border-slate-700 text-slate-400'
            }`}
          >
            {PHASE_LABEL[ph]}
          </span>
        ))}
      </nav>
      {/* 阶段动作提示（D-258）—— 充能阶段用琥珀底色，因为它最容易被忽略。 */}
      {phaseHint ? (
        <p
          className={`rounded px-2 py-1 text-center text-[11px] ${
            state.phase === 'charge'
              ? 'bg-amber-500/15 text-amber-200'
              : state.phase === 'mulligan'
                ? 'bg-violet-500/15 text-violet-200'
                : 'bg-slate-800/60 text-slate-300'
          }`}
          data-testid="phase-hint"
        >
          {phaseHint}
        </p>
      ) : null}
      {/*
        提示条（D-256 / issue #114）—— **在流内、独占一行**，排在阶段提示条下方。

        原来是 `fixed left-1/2 top-16`：`top-16` = 64px，正好压在下面的 `<header>`
        （回合数 / 阶段 / 计时那一行，实测 y 63~83）上，计时被整个盖住。
        现在改为普通块：出现时把桌面整体往下推约 30px（一条 26px + 根容器 4px 间距，
        比盖住计时好得多），消失时回弹；仍可点一下手动关掉（`dismiss`），
        不点的话由客户端的 4s 定时器自动消退（见 `useRoom` 的 notice effect）。
      */}
      {notice ? (
        <div className="flex justify-center">
          <button
            type="button"
            className="rounded-lg border border-amber-500/60 bg-amber-950/95 px-4 py-1 text-xs text-amber-100 shadow-lg"
            onClick={dismiss}
            data-testid="notice"
          >
            {notice}
          </button>
        </div>
      ) : null}

      {/* 卡牌详情浮层 —— 信息查看（任何阶段可用，不受回合/阶段置灰约束）。
          B3-2 的「不要弹窗」约束的是**出牌确认**；详情查看按 docs/11 X-13 默认建议用大卡浮层。 */}
      {showIntro ? (
        <IntroGuide
          onDone={() => {
            try {
              localStorage.setItem(INTRO_SEEN_KEY, '1');
            } catch {
              // 隐私模式下写不进去 —— 本次会话仍然关掉，下次再弹一次无伤大雅
            }
            setShowIntro(false);
          }}
        />
      ) : null}
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
      {/* 回合数 / 计时居中（B2-5）。
          issue #114：390px 下这一行原来没有折字约束 —— 各 span 被压到**文字内部**折行
          （「开 局」「阶段 换 / 牌」），读起来像乱码。现在：
          1. 每段 `whitespace-nowrap`：宁可整块换行，也不把词拆开；
          2. `flex-wrap` + `gap-x-3 gap-y-0.5`：极端情况（对手断线横幅、BO3 比分）
             让多出来的段落到第二行，而不是把每个字挤成一条；
          3. 成长资源 `my-growth` 窄屏隐藏 —— 390px 放不下，资源数在区域与卡面详情里可查。
          `sm:` 以上三处的**视觉结果不变**（单行布局下 `gap-y` 不起作用、桌面本来也不折行）。 */}
      <header className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 text-xs sm:text-sm">
        <span className="whitespace-nowrap" data-testid="turn">
          {state.phase === 'mulligan' ? '开局' : `第 ${state.turn} 回合`}
        </span>
        <span className="whitespace-nowrap text-slate-400" data-testid="phase">
          阶段 {PHASE_LABEL[state.phase]}
        </span>
        {/* 计时（D-267）：换牌阶段下发的是**换牌截止时刻**，不再是「—」（issue #99）。 */}
        <span className="whitespace-nowrap text-slate-400" data-testid="clock">
          计时 {remain === null ? '—' : `${remain}s`}
        </span>
        {/*
          血量**不在**这里显示 —— Era 2026-10-14 指定：血量就在指挥官区显示。
          故血量徽标挂在两侧的指挥官区上（见下方 `badge`）。
        */}
        {/*
          换牌阶段（D-259）不属于任何回合 —— 显示「你的回合」会误导（先攻方会以为已经开始）。
          改为双方各自的确认状态，谁没确认一眼可见。
        */}
        {state.phase === 'mulligan' ? (
          <span className="whitespace-nowrap text-violet-300" data-testid="mulligan-status">
            {mine.mulliganDone ? '你已确认' : '等你换牌'} · {theirs.mulliganDone ? '对手已确认' : '对手换牌中'}
          </span>
        ) : (
          /*
           * 回合归属（D-268）—— 文案与色调都来自 `turnGuidance`，不在这里二次判断：
           * 边界在播时显示「回合切换中…」，避免结束回合的一方先看到「你的回合 · 充能阶段」。
           */
          <span
            className={`whitespace-nowrap ${
              guide.tone === 'mine'
                ? 'text-emerald-400'
                : guide.tone === 'pending'
                  ? 'text-amber-300'
                  : 'text-slate-400'
            }`}
            data-testid="turn-label"
          >
            {guide.label}
          </span>
        )}
        {/* 对手断线（D-233）：宽限期内给明确提示，否则「对面不动」看起来像自己卡了 */}
        {foeOffline ? (
          <span
            className="whitespace-nowrap rounded bg-amber-900/80 px-2 py-0.5 text-amber-200"
            data-testid="foe-offline"
          >
            对手已断线（{graceSeconds} 秒内可重连）
          </span>
        ) : null}
        {/* 赛制与比分（D-132）—— 只在 BO3 显示，BO1 显示会占位制造噪音。
            `gameNo` 是**已完成**的小局数，故进行中的是第 `gameNo + 1` 局。 */}
        {room.format === 'bo3' ? (
          <span className="whitespace-nowrap text-slate-400" data-testid="series">
            第 {room.gameNo + 1} 局 · 比分{' '}
            {room.wins[me] ?? 0} : {Object.entries(room.wins).filter(([id]) => id !== me).reduce((a, [, w]) => Math.max(a, w), 0)}
          </span>
        ) : null}
        {/* 专属成长资源（D-229 / D-230）—— 玩家每轮都能看到自己在变强。
            issue #114：**窄屏隐藏**。390px 的顶栏放不下这一段（与计时挤在一起就折字），
            资源数在「区域」与卡面详情里都能查到；桌面（`sm:` 起）照旧显示，
            `game.spec.ts` 的 `my-growth` 断言跑的是默认桌面视口，不受影响。 */}
        {myGrowth ? (
          <span className="hidden whitespace-nowrap text-cyan-300 sm:inline" data-testid="my-growth">
            {myGrowth}
          </span>
        ) : null}
        {/*
          指挥官攻击（D-258，Era 2026-10-21）——**不再放固定按钮**。
          原来这里常驻一个「指挥官攻击（N 点）」，与随从的「点自己 → 点目标」
          是两套操作；现在统一成同一套：点我方指挥官选中，再点对方指挥官结算。
          选中后的提示与「攻击并展示」入口在下方操作条里。
        */}
      </header>

      {/* 选位提示（D-257）—— 已移到随从区下方**参与布局**（issue #130），见第 ④ 排之后。 */}

      {/* 支付选卡（D-257）—— 费用区比「该付的张数」多时才出现，否则没什么可挑的。 */}
      {payPicker ? (
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/70 p-3"
          data-testid="pay-picker"
        >
          <div className="w-full max-w-md rounded-xl border border-cyan-700 bg-slate-900 p-3">
            <p className="text-sm text-cyan-100">
              选择支付哪 {payPicker.pay} 张费用（已选 {payPicker.picks.length} 张）
            </p>
            <p className="mt-1 text-[11px] text-slate-400">点卡切换。哪些卡进弃牌区由你决定。</p>
            <div className="mt-2 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
              {mine.zones.cost.map((k) => {
                const on = payPicker.picks.includes(k.uid);
                return (
                  <button
                    key={k.uid}
                    type="button"
                    className={
                      on
                        ? 'rounded border border-cyan-400 bg-cyan-900/60 px-2 py-1 text-[11px] text-cyan-100'
                        : 'rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-300'
                    }
                    onClick={() =>
                      setPayPicker((prev) => {
                        if (!prev) return prev;
                        if (prev.picks.includes(k.uid)) {
                          return { ...prev, picks: prev.picks.filter((x) => x !== k.uid) };
                        }
                        // 已选满就不再追加 —— 让「选满」这件事在点第 N+1 张时看得见，而不是静默替换。
                        if (prev.picks.length >= prev.pay) return prev;
                        return { ...prev, picks: [...prev.picks, k.uid] };
                      })
                    }
                    data-testid={`pay-card-${k.uid}`}
                  >
                    {CARD_POOL[k.defId]?.name ?? k.defId}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="flex-1 rounded bg-emerald-700 px-3 py-2 text-sm disabled:opacity-40"
                disabled={payPicker.picks.length !== payPicker.pay}
                onClick={() => {
                  const opts: { costUids: string[]; slot?: number } = { costUids: payPicker.picks };
                  if (payPicker.slot !== undefined) opts.slot = payPicker.slot;
                  session.play(payPicker.uid, opts);
                  setPayPicker(null);
                  setPicked(null);
                  setPlacing(null);
                }}
                data-testid="pay-confirm"
              >
                确认出牌
              </button>
              <button
                type="button"
                className="rounded bg-slate-700 px-3 py-2 text-sm"
                onClick={() => setPayPicker(null)}
                data-testid="pay-cancel"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 事件呈现层（横幅/飘字）—— Era 2026-10-18：
          提示要醒目（中央 toast 而非底栏小字），可操作对象发光。
          ⚠️ 提示条 `notice` **不在这里**（issue #114）—— 它已改为顶栏上方的
          行内一块，见上方 `phaseHint` 之后；`fixed top-16` 会盖住回合计时。 */}
      <FxOverlay fx={fx} />

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
            <ZoneBox label="卡组区" zone="deck" cards={theirs.zones.deck} content="count" state={state} />
            <ZoneBox label="法术区" zone="spell" cards={theirs.zones.spell} content="float" state={state} />
            {/* ADR-0022：指挥官也是合法攻击目标 —— 否则只能互砍随从，永远分不出胜负。
                嘲讽优先由引擎裁决（A7），界面不预判，被拒就显示服务端原因。 */}
            <ZoneBox
              label="指挥官"
              zone="commander"
              cards={theirs.zones.commander}
              state={state}
              badge={`血 ${theirs.health}`}
              badgeTestId="hp-foe"
              /* issue #119：选中攻击方后，对方指挥官是合法目标 —— 用 `hittable` 的角标
                 （不是 `glow`）。指挥官不走「破坏」，角标同样要出现，否则玩家只敢砍随从。 */
              hittable={attacker !== null}
              dropUid={theirs.zones.commander[0]?.uid}
              highlight={dragging?.kind === 'minion'}
              fxFor={(uid) => combatClass(uid, 'foe')}
              onCardClick={
                attacker && myTurn
                  ? (uid) => {
                      // D-258：指挥官攻击的目标恒为敌方指挥官，不需要 targetUid。
                      if (commanderAttacking) session.commanderAttack();
                      else session.attack(attacker, uid);
                      setAttacker(null);
                    }
                  : undefined
              }
            />
            <ZoneBox label="弃牌区" zone="graveyard" cards={theirs.zones.graveyard} content="float" state={state} />
            <ZoneBox label="除外区" zone="exile" cards={theirs.zones.exile} content="float" state={state} />
          </section>

          {/* ③ 对方费用区 + 随从区 1·2·3 + 展示区 —— D-123（Era 2026-10-18）：
              费用区居左、展示区居右，随从 1·2·3 与第 ④ 排**逐格对齐**。
              选中攻击方后对方随从挂「可攻击」角标（`hittable`，issue #119）——
              嘲讽等限制仍由引擎裁决，界面不预判。 */}
          <section className="grid min-h-0 flex-1 auto-rows-fr grid-cols-5 gap-1">
            <ZoneBox label="费用区" zone="cost" cards={theirs.zones.cost} content="float" state={state} />
            {slots.map((i) => {
              const fc = atSlot(theirs.zones.board, i);
              return (
                <BoardSlot
                  key={i}
                  index={i}
                  state={state}
                  card={fc}
                  /* issue #119：可被攻击的目标挂角标（原来这里是 glow，只让描边变一点点色）。 */
                  hittable={attacker !== null && !!fc}
                  dropUid={fc?.uid}
                  highlight={dragging?.kind === 'minion' && !!fc}
                  fxClass={fc ? combatClass(fc.uid, 'foe') : undefined}
                  ghost={
                    destroyGhost && destroyGhost.side === 'foe' && destroyGhost.slotIndex === i
                      ? destroyGhost.card
                      : undefined
                  }
                  onClick={
                    // 指挥官只能打指挥官（docs/16 §6.2）—— 指挥官攻击时不把随从格子做成落点。
                    attacker && myTurn && !commanderAttacking
                      ? () => {
                          if (fc) session.attack(attacker, fc.uid);
                          setAttacker(null);
                        }
                      : undefined
                  }
                />
              );
            })}
            <RevealBox
              cards={revealCards(state, foe, foe ? (revealed[foe] ?? []) : [])}
              state={state}
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
              dragging?.kind === 'hand' && state.phase === 'main' && draggingHandType === 'minion'
                ? 'ring-2 ring-cyan-400/70'
                : ''
            } ${myTurn ? 'shadow-[0_0_14px_rgba(52,211,153,0.12)]' : ''}`}
            data-drop="board"
          >
            <ZoneBox
              label="费用区"
              zone="cost"
              cards={mine.zones.cost}
              content="float"
              state={state}
              badge={`本回合 ${costText}`}
              badgeTestId="cost-usage"
              dropKey="cost"
              highlight={
                dragging?.kind === 'hand' && state.phase === 'charge' && draggingHandType === 'minion'
              }
            />
            {slots.map((i) => {
              const mc = atSlot(mine.zones.board, i);
              const minionOperable = !!mc && canBattle && !mc.sleeping;
              /*
               * 选位模式（D-257）：三格全部高亮，标签说明「放这里」还是「顶替」。
               * 这一步优先于「选攻击方」—— 出牌流程没走完时点格子只可能是在选位置。
               */
              const placingHere = placing !== null;
              return (
                <BoardSlot
                  key={i}
                  index={i}
                  state={state}
                  card={mc}
                  selected={!placingHere && attacker === mc?.uid}
                  disabled={!canBattle || (mc?.sleeping ?? false)}
                  glow={
                    placingHere ? true : canBattle && !(mc?.sleeping ?? false) && attacker !== mc?.uid && !!mc
                  }
                  hint={placingHere ? (mc ? `顶替 ${CARD_POOL[mc.defId]?.name ?? ''}` : '放这里') : undefined}
                  dropSlot={placingHere || state.phase === 'main' ? i : undefined}
                  dragKind={minionOperable ? 'minion' : undefined}
                  dragUid={minionOperable ? mc?.uid : undefined}
                  fxClass={mc ? combatClass(mc.uid, 'me') : undefined}
                  ghost={
                    destroyGhost && destroyGhost.side === 'me' && destroyGhost.slotIndex === i
                      ? destroyGhost.card
                      : undefined
                  }
                  /*
                   * 整格点击挂在**最外层**（`onSlotClick`）而不是卡片上：
                   * 空格子里没有卡片节点，挂在卡片上就等于「空位点不了」——
                   * 这正是 D-257 首版的实际表现（点了「出牌」卡还在手上）。
                   * 卡片上的 `onClick` 因此不再传，避免一次点击触发两遍。
                   */
                  onSlotClick={() => {
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
                    if (placing !== null) {
                      commitPlay(placing, i);
                      return;
                    }
                    // 非战斗阶段 / 休眠随从不响应选中 —— 原来靠卡片自身的 `disabled` 挡，
                    // 现在点击提到了格子上，这条守卫必须显式写回来。
                    if (!minionOperable) return;
                    const uid = mc?.uid;
                    setAttacker((prev) => (prev === uid ? null : (uid ?? null)));
                  }}
                />
              );
            })}
            <RevealBox
              cards={revealCards(state, me, revealed[me] ?? [])}
              state={state}
            />
          </section>

          {/* 选位提示（D-257 / issue #130）—— **参与布局**，不再是 `fixed bottom-16`。
              原来那条横跨全宽、压在**手牌**下半部分上，正好盖住「费 / 力 / 伤」——
              而「我这张牌多大」恰恰是玩家选位置时最想再确认一眼的东西：
              提示条本意是帮忙，结果挡住了决策信息。
              现在它插在随从区与五区之间，占一行高度，不覆盖任何内容；
              仍然常显 —— 「点了出牌、卡还在手上、桌面没变化」那个坑（D-256）不能回来。 */}
          {placing ? (
            <div
              className="flex items-center gap-2 rounded border border-cyan-600 bg-cyan-950/60 px-2 py-1 text-[11px] text-cyan-100"
              role="status"
              data-testid="placing-hint"
            >
              <span className="flex-1">
                点我方随从区的格子放下 —— 空位直接放入，有随从则顶替（被顶替者进弃牌区）
              </span>
              <button
                type="button"
                className="shrink-0 rounded bg-slate-700 px-2 py-1"
                onClick={() => {
                  setPlacing(null);
                  setPicked(null);
                }}
                data-testid="placing-cancel"
              >
                取消
              </button>
            </div>
          ) : null}

          {/* ⑤ 我方五区 —— 与第 ② 排（对方五区）**严格镜像**（Era 2026-10-14）。
              ② 卡组/法术/指挥官/弃牌/除外 → ⑤ 除外/弃牌/指挥官/法术/卡组。
              原第 2 格是「费用区」，导致我方**看不到自己的弃牌区**；
              费用区在第 ④ 排已有一格，故此处换成弃牌区不丢信息。
              flex-1 平分桌高。 */}
          <section className="grid min-h-0 flex-1 auto-rows-fr grid-cols-5 gap-1">
            <ZoneBox label="除外区" zone="exile" cards={mine.zones.exile} content="float" state={state} />
            <ZoneBox label="弃牌区" zone="graveyard" cards={mine.zones.graveyard} content="float" state={state} />
            <ZoneBox
              label="指挥官"
              zone="commander"
              cards={mine.zones.commander}
              state={state}
              badge={`血 ${mine.health}`}
              badgeTestId="hp-me"
              fxFor={(uid) => combatClass(uid, 'me')}
              /* D-258：点自己的指挥官 = 选中它作为攻击方（与随从同一套操作）。 */
              selected={commanderAttacking}
              glow={canCommanderAttack && !commanderAttacking}
              onCardClick={
                canCommanderAttack
                  ? (uid) => setAttacker((prev) => (prev === uid ? null : uid))
                  : undefined
              }
            />
            <ZoneBox
              label="法术区"
              zone="spell"
              cards={mine.zones.spell}
              content="float"
              state={state}
              /* issue #108：法术没有「位置」概念，拖到法术区就该直接出牌（与点「出牌」等价） */
              dropKey="spell"
              highlight={
                dragging?.kind === 'hand' &&
                state.phase === 'main' &&
                draggingHandType !== undefined &&
                draggingHandType !== 'minion'
              }
            />
            {/* 抽牌阶段未抽时，卡组区变为发光动作「点击抽牌」（Era 2026-10-18 手动抽牌）。
                卡组区**不给 inspectable**（D-265）：卡组顺序是隐藏信息 ——
                能翻看就等于提前知道下一张抽什么，本来那一版点标题能看到 25 张。
                抽牌动作走下方按钮，与「查看内容」不冲突。 */}
            <ZoneBox
              label="卡组区"
              zone="deck"
              cards={mine.zones.deck}
              content="count"
              state={state}
              action={
                canDraw ? { label: '点击抽牌', testId: 'draw-deck', onClick: () => session.draw() } : undefined
              }
            />
          </section>

          {/* ⑥ 我方手牌 —— 卡宽按张数**自适应**（issue #113）。
              Era 2026-10-18 两条：
              1. 非充能/主要阶段手牌**置灰不可点**（不可操作不给高亮）；
              2. 选中**排他**（最多一张高亮），操作按钮**挂在卡的附近**（B3-2），
                 不再放底部固定操作条。 pt-9 给浮出的按钮组留位。

              卡宽**不再写死 `w-16`**（issue #113）：390px 下手牌区内容宽约 372px，
              6 张固定宽 = 6×64 + 5×4 = 404，横溢出 32px，最后一张被裁在滚动区外。
              现在每个卡位是 `flex-1 min-w-0` 的**均分单元**、`max-w-16 sm:max-w-20` 封顶：
              窄屏 6 张各约 58px（≥ issue 要求的 56px）、8 张各约 43px；
              桌面以 80px 封顶，与原来视觉一致。
              `overflow-x-auto` 保留，但只是**兜底**：常态靠自适应宽度不产生滚动，
              只有手牌多到连均分都不可读时才用得上（手指横滑会被卡上的拖拽判定吃掉，
              本来也不能当交互手段）。 */}
          <section className="overflow-x-auto rounded border border-slate-700 bg-slate-900/40 p-1 pt-9">
            <div className="flex gap-1" data-testid="hand">
              {mine.zones.hand.map((c) => (
                <div
                  key={c.uid}
                  className="relative min-w-0 max-w-16 flex-1 sm:max-w-20"
                  {...(canPickHand && !mulliganOpen ? { 'data-drag-kind': 'hand', 'data-drag-uid': c.uid } : {})}
                >
                  {picked === c.uid && !mulliganOpen ? (
                    <div className="absolute -top-8 left-1/2 z-10 flex -translate-x-1/2 gap-1">
                      {/* 不可操作的按钮不展示（Era 2026-10-19）：出牌只在主要阶段、充能只在充能阶段出现 */}
                      {state.phase === 'main' ? (
                        <button
                          type="button"
                          className="rounded bg-cyan-800 px-2 py-1 text-[11px] whitespace-nowrap"
                          onClick={() => startPlay(c.uid)}
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
                      {/* D-261（issue #87）：详情按钮挂在选中后浮出的操作组里 ——
                          比原来角落那个 16px 的「?」好点得多，也不用学「长按」。
                          任何阶段都可用：看卡是信息行为，不是操作。 */}
                      <button
                        type="button"
                        className="rounded bg-slate-700 px-2 py-1 text-[11px] whitespace-nowrap"
                        onClick={() => openDetail(c)}
                        data-testid="card-detail-open"
                      >
                        详情
                      </button>
                    </div>
                  ) : null}
                  <CardOf
                    card={c}
                    state={state}
                    fluidWidth
                    selected={mulliganOpen ? mulliganPicks.includes(c.uid) : picked === c.uid}
                    disabled={!canPickHand}
                    glow={mulliganOpen || (canPickHand && picked !== c.uid)}
                    onClick={() => {
                      if (!mulliganOpen) {
                        togglePick(c.uid);
                        return;
                      }
                      // 换牌窗口已耗尽：点了也不会有提交（服务端正在替我们跳过），不如不响应
                      if (!mulliganExpired) toggleMulliganPick(c.uid);
                    }}
                  />
                </div>
              ))}
              {mine.zones.hand.length === 0 ? (
                <span className="px-2 text-[11px] text-slate-400">手牌为空</span>
              ) : null}
            </div>
          </section>
        </div>

        {/*
          右侧一列：只放战报（B2-5 原为「日志框 + 对话框分开展示」）。

          T-02：窄屏（<640px）不再整列隐藏 —— 原来 `hidden sm:flex` 让 390px 竖屏下
          战报彻底消失，玩家看不到「谁打了谁」。现在窄屏改为「日志」按钮展开的浮层抽屉
          （`fixed inset-x-2 bottom-2 top-16`），桌面仍是常驻右列。

          issue #122 / D-307：对话框那块「占位」**整块删掉了**，不是加说明。
          `docs/22` N-09 已定第一版不做好友/私聊，而空面板对玩家没有任何信息价值 ——
          它只会让人以为「有消息没加载出来」或「聊天坏了」。所以从玩家视角直接不存在。
          真要加聊天时，这一列再加回来（`aside` 已是 `flex-col`，塞进去即可）。
        */}
        <aside
          className={`${
            logOpen
              ? 'fixed inset-x-2 top-16 bottom-2 z-[65] flex w-auto'
              : 'hidden'
          } flex-col gap-1 sm:static sm:z-auto sm:flex sm:w-40 sm:shrink-0 md:w-56`}
          data-testid="log-panel"
        >
          <div
            ref={logRef}
            className="min-h-0 flex-1 overflow-y-auto rounded border border-slate-700 bg-slate-900/95 p-1 text-[11px] sm:bg-slate-900/60"
            data-testid="log"
          >
            {log.map((l) => (
              <p key={l.id} className="text-slate-300">
                {l.text}
              </p>
            ))}
          </div>
          {/* 抽屉的关闭入口只在窄屏出现（桌面没有抽屉这回事） */}
          <button
            type="button"
            className="rounded bg-slate-700 py-2 text-xs sm:hidden"
            onClick={() => setLogOpen(false)}
            data-testid="log-close"
          >
            收起日志
          </button>
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
      {/*
        终局（issue #154）：结算以覆盖层出现，牌桌仍可见 —— 但操作条必须消失。
        否则「认输 / 推进 / 结束回合」还挂在那里，点下去只会换成服务端一句 GAME_OVER。
        出口由结算卡片自己提供（返回主界面 / 收起后的小条）。
      */}
      {over ? null : (
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
        {/* 起手换牌（D-259）：**游戏开始之前**的独立阶段，不属于任何回合。
            双方同时可选（不看轮次），每人只要提交一次就能推进；
            双方都提交后服务端发 `mulligan:closed`，才真正进第一回合。
            「不换牌」= 提交空数组，不是取消 —— 没有「退出换牌」这条路。 */}
        {mulliganOpen ? (
          <>
            {mulliganExpired ? (
              /*
               * 倒计时归零（D-267）：服务端在这一刻替未确认方提交「不换牌」，
               * 阶段马上会关闭。这里不再给提交入口 —— 玩家点了也只会收到
               * 「当前已不是开局换牌阶段」，等于用一句拒绝提示换一次困惑。
               */
              <span
                className="rounded bg-slate-800 px-3 py-2 text-xs text-slate-400 sm:text-sm"
                data-testid="mulligan-expired"
              >
                换牌时间到，正在开局…
              </span>
            ) : mulliganPicks.length > 0 ? (
              <>
                <button
                  type="button"
                  className="rounded bg-violet-700 px-3 py-2 text-xs sm:text-sm"
                  onClick={() => {
                    /*
                     * 提交前清洗（D-267）：只允许非空字符串。
                     *
                     * `mulliganRule` 的 `strListArg` 对**数组里混入空串 / 非字符串**同样返回 null，
                     * 报回来的还是那句内部契约文案。界面上的 uid 来自 `c.uid`，正常不会脏，
                     * 但这里是最靠近网络的一层 —— 在它之前挡掉，比让玩家看引擎报错强。
                     */
                    session.mulligan(mulliganPicks.filter((uid) => typeof uid === 'string' && uid.length > 0));
                    setMulliganPicks([]);
                  }}
                  data-testid="mulligan-confirm"
                >
                  确认换牌（{mulliganPicks.length}）
                </button>
                <button
                  type="button"
                  className="rounded bg-slate-700 px-3 py-2 text-xs sm:text-sm"
                  onClick={() => setMulliganPicks([])}
                  data-testid="mulligan-clear"
                >
                  清空选择
                </button>
              </>
            ) : (
              <button
                type="button"
                className="rounded bg-violet-800 px-3 py-2 text-xs sm:text-sm"
                onClick={() => session.mulligan([])}
                data-testid="mulligan-skip"
              >
                不换牌
              </button>
            )}
          </>
        ) : null}
        {/* 已选中随从作为攻击方（issue #119）—— 指挥官那句提示原先只为指挥官写了，
            随从选中后操作条上一句话都没有，玩家不知道下一步点谁。力量一并报出来，
            因为「这一下打不打得赢」是玩家此刻真正在算的事。 */}
        {attacker !== null && !commanderAttacking ? (
          <span
            className="rounded bg-rose-900/60 px-2 py-1 text-[11px] text-rose-100"
            data-testid="attacker-selected"
          >
            已选随从（力 {core.unitPower(state, CARD_POOL, attacker) ?? 0}）→ 点带「可攻击」角标的单位或指挥官
          </span>
        ) : null}
        {/* 指挥官已选中（D-258）：说明下一步点哪里，以及这次能打几点。 */}
        {commanderAttacking ? (
          <span className="rounded bg-rose-900/60 px-2 py-1 text-[11px] text-rose-100" data-testid="commander-selected">
            已选指挥官（{1 + mine.commanderDamageBonus} 点）→ 点对方指挥官
          </span>
        ) : null}
        {/* 星轨观测者：攻击时【1】展示（docs/17 §3）—— 先展示、后结算伤害。
            现在只在指挥官被选中时出现，不再常驻头部。 */}
        {commanderAttacking && canRevealAttack ? (
          <button
            type="button"
            className="rounded bg-indigo-700 px-3 py-2 text-xs text-indigo-50 sm:text-sm"
            onClick={() => {
              session.commanderAttack(true);
              setAttacker(null);
            }}
            data-testid="commander-reveal-attack"
          >
            攻击并展示（1 费）
          </button>
        ) : null}
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
        {/*
          危险 / 退出类操作统一靠右，并与左侧常用操作之间加一道竖线（issue #120）。

          原来「认输」就排在「取消攻击」右边 4px 处，同一行同一高度 —— 取消一次攻击
          的手滑直接落到认输上。认输本身有二次确认，但**确认按钮原本长在原位**：
          连点两下就成立了，二次确认形同虚设。现在确认态改到居中浮层（见文件末尾），
          这条操作条上只剩一个入口，且与常用操作隔开。
        */}
        <div
          className="ml-auto flex flex-wrap items-center gap-2 border-l border-slate-700 pl-2"
          data-testid="danger-bar"
        >
          <button
            type="button"
            className="rounded bg-slate-800 px-3 py-2 text-xs text-slate-300 sm:text-sm"
            onClick={() => setConcedeArmed(true)}
            data-testid="concede"
          >
            认输
          </button>
          <button
            type="button"
            className="rounded bg-slate-800 px-3 py-2 text-xs sm:text-sm"
            onClick={session.leave}
            data-testid="leave"
          >
            离开
          </button>
          {/* 日志抽屉入口（T-02）—— 只在窄屏需要；桌面日志列常驻 */}
          <button
            type="button"
            className="rounded bg-slate-800 px-3 py-2 text-xs sm:hidden"
            onClick={() => setLogOpen((v) => !v)}
            data-testid="log-toggle"
          >
            {logOpen ? '关闭日志' : '日志'}
          </button>
          {/* 音效开关（P-06）—— 选择存本机；静音只影响本端，不影响对手 */}
          <button
            type="button"
            className={`rounded px-3 py-2 text-xs sm:text-sm ${sfxOn ? 'bg-slate-800' : 'bg-slate-900 text-slate-500'}`}
            onClick={() => {
              const next = !sfxOn;
              setSfxOn(next);
              setSfxMuted(!next);
            }}
            data-testid="sfx-toggle"
          >
            音效：{sfxOn ? '开' : '关'}
          </button>
        </div>
        {/* 详情入口提示（D-261）—— 长按没有视觉提示，这里常显一句，否则发现不了。 */}
        <span className="text-[10px] text-slate-500" data-testid="detail-hint">
          长按卡牌看详情
        </span>
      </footer>
      )}

      {/*
        认输确认浮层（issue #120 / D-295）—— **居中**，不留在原按钮位置。

        「二次确认」挡的是「没想清楚」，挡不住「手滑连点」：只要确认按钮还长在
        原按钮那一点上，两下连击就真的判负了。换到屏心 + 两个按钮要大（44px 级），
        才真正要求玩家**重新瞄准**一次。

        层级 z-[68]：高于操作条（z-60）与待定选择浮层（z-50），低于新手引导（z-70）。
      */}
      {concedeArmed ? (
        <div
          className="fixed inset-0 z-[68] flex items-center justify-center bg-black/60 p-4"
          data-testid="concede-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="确认认输"
        >
          <div className="w-full max-w-xs rounded-xl border border-rose-700 bg-slate-900 p-4 text-center">
            <p className="text-sm font-medium text-rose-200">认输 = 本局判负</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-300">
              本局立即判负，不可撤销。BO3 下只是输掉这一局，系列赛按当前比分继续。
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                className="min-h-11 flex-1 rounded bg-slate-700 px-3 py-2 text-sm text-slate-100"
                onClick={() => setConcedeArmed(false)}
                data-testid="concede-cancel"
              >
                继续对战
              </button>
              <button
                type="button"
                className="min-h-11 flex-1 rounded bg-rose-700 px-3 py-2 text-sm font-medium text-rose-50"
                onClick={() => {
                  setConcedeArmed(false);
                  session.concede();
                }}
                data-testid="concede-confirm"
              >
                确认认输
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 拖拽预览 —— 跟随指针的浮动卡（B3-1 拖拽手感）。pointer-events-none 不挡落点判定。
          复用 `CardOf`（而不是手抄一份数值）—— 否则局内「实际值」口径会在这里漏掉一处。 */}
      {dragCard && dragPos ? (
        <div
          className="pointer-events-none fixed z-50 opacity-90"
          style={{ left: dragPos.x - 32, top: dragPos.y - 44 }}
          data-testid="drag-preview"
        >
          <CardOf card={dragCard} state={state} />
        </div>
      ) : null}

      {/*
        结算覆盖层（issue #154）—— 牌桌与右侧战报留在下面，DOM 不再被替换。

        层级 z-[75]：高于操作条（z-60）、认输浮层（z-68）、移动端日志抽屉（z-65），
        但**低于断线横幅（z-80）** —— 「与服务器断开」是全局状态，任何时候都该压在最上面。
      */}
      {over ? (
        <GameOverPanel
          state={state}
          me={me}
          room={room}
          onBack={session.leave}
          onNextGame={session.nextGame}
          onRematch={session.rematch}
          collapsed={resultCollapsed}
          onCollapseChange={setResultCollapsed}
        />
      ) : null}
    </div>
  );
}
