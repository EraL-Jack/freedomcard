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
  onSelect?: () => void;
}

export default function CardTile(props: CardTileProps): React.JSX.Element {
  const base = 'flex min-h-[44px] w-full flex-col justify-between rounded border p-1 text-left';
  const kind = KIND_STYLE[props.kind] ?? KIND_STYLE.minion;
  const state = [
    props.selected ? 'ring-2 ring-amber-400' : '',
    props.disabled ? 'opacity-40' : 'active:scale-95',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={`${base} ${kind} ${state}`}
      onClick={props.onSelect}
      disabled={props.disabled}
      title={props.text ?? props.name}
      data-testid="card"
    >
      <span className="truncate text-[11px] leading-tight">{props.name}</span>
      <span className="flex items-center justify-between text-[10px] leading-none">
        <span>费 {props.cost}</span>
        <span>力 {props.power}</span>
      </span>
      {props.sleeping ? <span className="text-[9px] text-slate-400">休眠</span> : null}
    </button>
  );
}
