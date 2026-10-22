import type { CardType } from '@app/shared/types';

/**
 * 卡牌渲染 —— D-118 视觉重做（Era 2026-10-18「展示方面不像是卡牌游戏」/ docs/11 R2）。
 *
 * 卡牌游戏通用视觉语言：竖版卡框（5:7）、类型色框、卡名条、插图区
 * （B7-1 素材缺，类型色块占位）、底部费用/力量/伤害**胶囊徽章**、休眠横置。
 *
 * ⚠️ 三条纪律：
 *  1. **不做任何规则判断** —— 「能不能出」由服务端校验（ADR-0002），置灰/发光只是呈现。
 *     数值怎么算是调用方的事（局内传实际值、构筑视角传卡面值，见 `cost` / `faceDamage` 注释）。
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

/** 类型文字标签（A6-1 四类）—— 色觉障碍玩家不能只靠颜色分辨（X-2 规则也有文字依据需求）。
 *
 * 「设置法术」= Era 2026-10-19 定名（原「持续法术」）：设置在场上、结算后留在法术区。
 * 代码标识符仍是 `continuous`（改名会波及回放与协议），只有中文显示统一。
 */
const KIND_TAG: Readonly<Record<CardType, string>> = {
  commander: '指挥官',
  minion: '随从',
  spell: '法术',
  continuous: '设置',
};

export interface CardTileProps {
  name: string;
  /** 显示费用。**局内传实际支付值**（`costToPay`，随从 −1），卡组编辑等「构筑视角」传卡面值（D-232）。 */
  cost: number;
  power: number;
  /**
   * 打脸伤害（D-232）—— 局内传**实际结算值**（`faceDamageOf`，按当前力量分档），
   * 未传则不渲染伤害位。指挥官没有这个数值（打脸伤害是玩家级属性）。
   */
  faceDamage?: number;
  kind: CardType;
  text?: string;
  /** 休眠态（A9-2：攻击后休眠，重置阶段清除）—— 横置 90°，卡牌游戏通用语言。 */
  sleeping?: boolean;
  /** 冻结态（ADR-0025）：跳过下一次重置 —— 冰蓝描边 + 「冻结」角标。 */
  frozen?: boolean;
  selected?: boolean;
  disabled?: boolean;
  /**
   * 「当前可以操作我」的正向提示 —— Era 2026-10-18：
   * 可执行操作的对象边框发光（与不可操作置灰互补）。
   */
  glow?: boolean;
  /**
   * 「我是攻击目标」（issue #119 / D-294）。
   *
   * 与 `glow` 分开是刻意的：`glow` 是「你可以操作**我**」（自己的随从、自己的指挥官），
   * `hittable` 是「**我**可以被他打」（对手的单位）。两者在同一个界面上同名同色，
   * 玩家就分不清哪个是「点它来出手」、哪个是「点它来挨打」。
   *
   * 原实现把对手目标也塞进 `glow`，效果只是一圈同色系描边 —— 对方随从的卡框本来就是
   * 青色的，微调看不出来，玩家点完自己的随从会以为卡住了。这里改为**角标文字**：
   * 颜色可以骗人，字不会。
   */
  hittable?: boolean;
  /** 战斗呈现类名（如攻击冲撞 / 受击抖动），由 TableScreen 按正在播放的裁决事件注入。 */
  fxClass?: string;
  /**
   * 高度适配模式（Era 2026-10-18 出框修复）：五区/随从格的行高被 grid 压缩时，
   * 卡高必须由**格子高度**决定（宽按 5:7 反算），否则 aspect 按宽算出的高会溢出格框。
   * 手牌等横向滚动行不用它 —— 那里宽度驱动即可。
   */
  fitHeight?: boolean;
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
    // 攻击目标：玫红描边 + 外发光（与 `glow` 的翠绿严格区分），并配下方角标文字。
    props.hittable && !greyed && !props.selected ? 'ring-2 ring-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.6)]' : '',
    greyed ? 'opacity-40' : interactive ? 'active:scale-95' : 'cursor-default',
  ]
    .filter(Boolean)
    .join(' ');

  const frame = KIND_FRAME[props.kind] ?? KIND_FRAME.minion;
  const art = KIND_ART[props.kind] ?? KIND_ART.minion;

  return (
    // 休眠横置作用在整个包装层（徽章随卡一起转），transition 让重置阶段「立回来」可见。
    <div
      className={`relative transition-transform duration-300 ${
        /*
         * D-264（issue #92）：`w-full min-w-0` —— 这里才是卡的**直接父级**。
         *
         * 卡上有 `w-full`，它取的是这一层宽度的百分比；这一层原来是 shrink-to-fit，
         * 宽度由卡自己撑出来（81px），于是「100%」等于「自己刚才的宽度」，
         * 越窄的容器反而越溢出。要让卡真正按容器宽度收敛，必须从这一层开始
         * 把宽度定下来（CardOf 的外套同理，两处都要有）。
         */
        props.fitHeight ? 'flex h-full min-h-0 w-full min-w-0 items-center justify-center' : ''
      } ${props.sleeping ? 'rotate-90 opacity-70' : ''}`}
    >
      <button
        type="button"
        className={`relative flex flex-col overflow-hidden rounded-lg border-2 p-1 text-left ${
          /*
           * D-264（issue #92）：窄屏**宽度驱动**，宽屏才高度驱动。
           *
           * 只写 `h-full + aspect`（高度驱动）时，卡片宽度由高度反算 —— 390px 下
           * 五区一格内容宽只有 63px，卡片却算出 81px，`max-w-full` 压不住它
           * （flex 子项的 `min-width:auto` + aspect 与 height 同时存在时，浏览器的
           * 优先级让 max-width 失效），于是压到隔壁区域上、甚至挤出视口。
           *
           * `sm:` 以上区域够宽，保持原来的高度驱动（卡片填满格子，视觉更饱满）。
           */
          props.fitHeight
            ? 'h-auto w-full max-h-full max-w-full min-w-0 aspect-[5/7] sm:h-full sm:w-auto'
            : 'aspect-[5/7] w-full'
        } ${frame} ${state} ${props.frozen ? 'ring-2 ring-sky-300 shadow-[0_0_12px_rgba(125,211,252,0.55)]' : ''} ${props.fxClass ?? ''}`}
        onClick={props.onSelect}
        disabled={greyed}
        title={props.text ?? props.name}
        data-testid="card"
      >
        {/* 卡名条（E2E 锚点：innerText 第一行 = 卡名）；显式文字色 —— 深底上不继承出白字。
            窄格里 5–6 字卡名（星轨观测者 / 霜律凛冬之刃）原先被 `truncate` 截成「星轨观…」——
            卡名是玩家最需要读的信息，改为最多两行换行，宁可让插图区矮一点。 */}
        <span className="line-clamp-2 rounded-sm bg-slate-950/50 px-1 text-[10px] font-medium leading-tight break-all text-slate-100">
          {props.name}
        </span>
        {/* 插图区占位（B7-1 素材缺）：类型色块 + 类型标签 */}
        <span className={`mx-0.5 mt-0.5 flex flex-1 items-center justify-center rounded-sm ${art}`}>
          <span className="text-[9px] leading-none" data-testid="card-kind">
            {KIND_TAG[props.kind]}
          </span>
        </span>
        {/* 底部数值胶囊（E2E 锚点：「费 N」「力 N」字样保留 —— 手牌/随从才有）。
            ⚠️ 指挥官没有费用与力量值（docs/16 §6.2.1 / docs/18 §3.1）：不渲染胶囊，
            否则卡面会出现「费 0 / 力 0」这种与规则矛盾的数值。 */}
        {props.kind === 'commander' ? null : (
          <span className="mt-0.5 flex items-end justify-between leading-none">
            <span className="rounded-full bg-blue-900/80 px-1.5 py-0.5 text-[10px] font-medium text-blue-200">
              费 {props.cost}
            </span>
            <span className="flex flex-col items-end gap-0.5">
              <span className="rounded-full bg-red-900/80 px-1.5 py-0.5 text-[10px] font-medium text-red-200">
                力 {props.power}
              </span>
              {/* 打脸伤害（D-232）—— 只有局内传了实际值才显示；卡面旧文案里的「伤害值」不再是权威。 */}
              {props.faceDamage === undefined ? null : (
                <span
                  className="rounded-full bg-rose-800/90 px-1.5 py-0.5 text-[9px] font-medium text-rose-100"
                  data-testid="card-damage"
                >
                  伤 {props.faceDamage}
                </span>
              )}
            </span>
          </span>
        )}
        {props.sleeping ? (
          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 bg-slate-950/70 text-center text-[9px] text-slate-300">
            休眠
          </span>
        ) : null}
        {props.frozen ? (
          <span className="absolute left-0.5 top-0.5 rounded bg-sky-800/90 px-1 text-[9px] leading-tight text-sky-100">
            冻结
          </span>
        ) : null}
        {/*
          攻击目标角标（issue #119）。压在插图区正中而不是右上角 ——
          右上角是卡名条，压上去会把最该读的字盖掉；插图区本来就是纯色占位。
          `pointer-events-none` 保证不会把点击吃掉（点击必须落到按钮上）。
        */}
        {props.hittable ? (
          <span className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 justify-center">
            <span
              className="rounded bg-rose-600/95 px-1 text-[9px] font-medium leading-tight text-white shadow"
              data-testid="hittable-mark"
            >
              可攻击
            </span>
          </span>
        ) : null}
      </button>
    </div>
  );
}
