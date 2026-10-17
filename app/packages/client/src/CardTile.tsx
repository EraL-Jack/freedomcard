import type { CardType } from '@app/shared';

/**
 * 占位卡 —— 架构默认「纯色 + 文字占位卡」（B7-2 待 Era 确认）。
 *
 * 只负责显示：卡名 / 费用 / 力量值 / 原始卡面文本。
 *
 * ⚠️ **不做任何规则判断** —— 「这张牌能不能出」由服务端校验，
 * 界面只负责发 Intent（ADR-0002）。置灰只是把结果反馈给玩家，不是本地裁决。
 */

/** 各类型的配色 —— 纯色占位，**不是**最终视觉方案（B6 待 Era 输入）。 */
const KIND_STYLE: Readonly<Record<CardType, string>> = {
  commander: 'border-amber-500 bg-amber-900/40',
  minion: 'border-cyan-500 bg-cyan-900/40',
  spell: 'border-fuchsia-500 bg-fuchsia-900/40',
  continuous: 'border-emerald-500 bg-emerald-900/40',
};

/**
 * 类型**文字**标签（A6-1 四类）。
 *
 * 只靠颜色区分类型是不够的：色觉障碍玩家分辨不出，且「哪些卡能充能」这类规则
 * （X-2 限定随从）必须有文字依据 —— 否则界面就是在逼玩家猜规则。
 */
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
  /** 休眠态（A9-2：攻击后休眠，重置阶段清除）。 */
  sleeping?: boolean;
  selected?: boolean;
  disabled?: boolean;
  /**
   * 「当前可以操作我」的正向提示 —— Era 2026-10-18：
   * 可执行操作的对象边框发光（与不可操作置灰互补）。
   */
  glow?: boolean;
  /** 查看详情入口（Era 2026-10-18：卡牌携带效果必须可查看）—— 存在时右上角挂「?」按钮。 */
  onDetail?: () => void;
  onSelect?: () => void;
}

export default function CardTile(props: CardTileProps): React.JSX.Element {
  const base = 'flex min-h-[44px] w-full flex-col justify-between rounded border p-1 text-left';
  const kind = KIND_STYLE[props.kind] ?? KIND_STYLE.minion;
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

  return (
    <div className="relative">
      <button
        type="button"
        className={`${base} ${kind} ${state}`}
        onClick={props.onSelect}
        disabled={greyed}
        title={props.text ?? props.name}
        data-testid="card"
      >
        <span className="truncate text-[11px] leading-tight">{props.name}</span>
        <span className="flex items-center justify-between text-[10px] leading-none">
          <span>费 {props.cost}</span>
          <span>力 {props.power}</span>
        </span>
        <span className="text-[9px] leading-none text-slate-400" data-testid="card-kind">
          {KIND_TAG[props.kind]}
        </span>
        {props.sleeping ? <span className="text-[9px] text-slate-400">休眠</span> : null}
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
