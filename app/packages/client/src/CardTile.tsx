import type { CardType } from '@app/shared';

/**
 * 卡牌渲染 —— D-118 视觉重做（Era 2026-10-18「展示方面不像是卡牌游戏」/ docs/11 R2）。
 *
 * 卡牌游戏通用视觉语言：竖版卡框（5:7）、类型色框、卡名条、插图区
 * （B7-1 素材缺，类型色块占位）、底部费用/力量**胶囊徽章**、休眠横置。
 *
 * ⚠️ 三条纪律：
 *  1. **不做任何规则判断** —— 「能不能出」由服务端校验（ADR-0002），置灰/发光只是呈现。
 *  2. **E2E 文本锚点不动**：`data-testid="card"` 的 innerText 第一行必须是卡名，
 *     且含「费 N」「力 N」字样与 `data-testid="card-kind"` —— helpers.readHand 依赖它们。
 *  3. 占位方案仍是「纯色+文字」（B7-2 架构默认），本组件只是把它做得像卡；
 *     正式美术到位后换插图区即可，结构不变。
 */

/** 类型框色 —— 占位配色（B6 待 Era 输入后走 CSS 变量整体换肤）。 */
const KIND_FRAME: Readonly<Record<CardType, string>> = {
  commander: 'border-amber-400 bg-amber-950/50',
  minion: 'border-cyan-500 bg-cyan-950/50',
  spell: 'border-fuchsia-500 bg-fuchsia-950/50',
  continuous: 'border-emerald-500 bg-emerald-950/50',
};

/** 插图区占位色（比框浅一档）。 */
const KIND_ART: Readonly<Record<CardType, string>> = {
  commander: 'bg-amber-800/60 text-amber-200',
  minion: 'bg-cyan-800/60 text-cyan-200',
  spell: 'bg-fuchsia-800/60 text-fuchsia-200',
  continuous: 'bg-emerald-800/60 text-emerald-200',
};

/** 类型文字标签（A6-1 四类）—— 色觉障碍玩家不能只靠颜色分辨（X-2 规则也有文字依据需求）。 */
const KIND_TAG: Readonly<Record<CardType, string>> = {
  commander: '指挥官',
  minion: '随从',
  spell: '法术',
  continuous: '持续',
};

export interface CardTileProps {
  name: string;
  cost: number;
  power: number;
  kind: CardType;
  text?: string;
  /** 休眠态（A9-2：攻击后休眠，重置阶段清除）—— 横置 90°，卡牌游戏通用语言。 */
  sleeping?: boolean;
  /** 霜冻态（ADR-0025）：跳过下一次重置 —— 冰蓝描边 + 「霜冻」角标。 */
  frozen?: boolean;
  selected?: boolean;
  disabled?: boolean;
  /**
   * 「当前可以操作我」的正向提示 —— Era 2026-10-18：
   * 可执行操作的对象边框发光（与不可操作置灰互补）。
   */
  glow?: boolean;
  /** 战斗呈现类名（如攻击冲撞 / 受击抖动），由 TableScreen 按正在播放的裁决事件注入。 */
  fxClass?: string;
  /**
   * 高度适配模式（Era 2026-10-18 出框修复）：五区/随从格的行高被 grid 压缩时，
   * 卡高必须由**格子高度**决定（宽按 5:7 反算），否则 aspect 按宽算出的高会溢出格框。
   * 手牌等横向滚动行不用它 —— 那里宽度驱动即可。
   */
  fitHeight?: boolean;
  /** 查看详情入口（Era 2026-10-18：卡牌携带效果必须可查看）—— 存在时右上角挂「?」按钮。 */
  onDetail?: () => void;
  onSelect?: () => void;
}

export default function CardTile(props: CardTileProps): React.JSX.Element {
  /**
   * 两种「不可点」要分开（Era 2026-10-18：不可操作的不给高亮/提示，尽量置灰）：
   *  - **静态展示**（没传 `onSelect`，如对方场上的卡）：正常显示，只是不可点；
   *  - **置灰**（传了 `onSelect` 但 `disabled`，如非出牌阶段的我方手牌）：
   *    是我方的操作入口但当前不可操作 —— 降透明度 + 禁点 + 不显示选中环。
   */
  const interactive = props.onSelect !== undefined;
  const greyed = interactive && props.disabled === true;
  const state = [
    props.selected && !greyed ? 'ring-2 ring-amber-400' : '',
    props.glow && !greyed && !props.selected ? 'ring-2 ring-emerald-400/80 animate-pulse' : '',
    greyed ? 'opacity-40' : interactive ? 'active:scale-95' : 'cursor-default',
  ]
    .filter(Boolean)
    .join(' ');

  const frame = KIND_FRAME[props.kind] ?? KIND_FRAME.minion;
  const art = KIND_ART[props.kind] ?? KIND_ART.minion;

  return (
    // 休眠横置作用在整个包装层（徽章随卡一起转），transition 让重置阶段「立回来」可见。
    <div
      className={`relative transition-transform duration-300 ${props.fitHeight ? 'flex h-full min-h-0 justify-center' : ''} ${props.sleeping ? 'rotate-90 opacity-70' : ''}`}
    >
      <button
        type="button"
        className={`relative flex flex-col overflow-hidden rounded-lg border-2 p-1 text-left ${
          props.fitHeight ? 'h-full max-w-full aspect-[5/7]' : 'aspect-[5/7] w-full'
        } ${frame} ${state} ${props.frozen ? 'ring-2 ring-sky-300 shadow-[0_0_12px_rgba(125,211,252,0.55)]' : ''} ${props.fxClass ?? ''}`}
        onClick={props.onSelect}
        disabled={greyed}
        title={props.text ?? props.name}
        data-testid="card"
      >
        {/* 卡名条（E2E 锚点：innerText 第一行 = 卡名）；显式文字色 —— 深底上不继承出白字 */}
        <span className="truncate rounded-sm bg-slate-950/50 px-1 text-[11px] font-medium leading-snug text-slate-100">
          {props.name}
        </span>
        {/* 插图区占位（B7-1 素材缺）：类型色块 + 类型标签 */}
        <span className={`mx-0.5 mt-0.5 flex flex-1 items-center justify-center rounded-sm ${art}`}>
          <span className="text-[9px] leading-none" data-testid="card-kind">
            {KIND_TAG[props.kind]}
          </span>
        </span>
        {/* 底部数值胶囊（E2E 锚点：「费 N」「力 N」字样保留） */}
        <span className="mt-0.5 flex items-center justify-between leading-none">
          <span className="rounded-full bg-blue-900/80 px-1.5 py-0.5 text-[10px] font-medium text-blue-200">
            费 {props.cost}
          </span>
          <span className="rounded-full bg-red-900/80 px-1.5 py-0.5 text-[10px] font-medium text-red-200">
            力 {props.power}
          </span>
        </span>
        {props.sleeping ? (
          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 bg-slate-950/70 text-center text-[9px] text-slate-300">
            休眠
          </span>
        ) : null}
        {props.frozen ? (
          <span className="absolute left-0.5 top-0.5 rounded bg-sky-800/90 px-1 text-[9px] leading-tight text-sky-100">
            霜冻
          </span>
        ) : null}
      </button>
      {props.onDetail ? (
        <button
          type="button"
          aria-label="查看卡牌详情"
          className="absolute -right-1 -top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-slate-500 bg-slate-800 text-[9px] leading-none text-slate-300"
          onClick={(e) => {
            e.stopPropagation();
            props.onDetail?.();
          }}
          data-testid="card-detail"
        >
          ?
        </button>
      ) : null}
    </div>
  );
}
