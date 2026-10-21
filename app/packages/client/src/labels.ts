import type { Phase, Zone } from '@app/shared/types';

/**
 * 显示用文案 —— **只在界面层使用，不进入状态与协议**。
 *
 * 单独成文件是为了让「界面文案」与「规则代码」彻底分离：
 * 改一个区域名的显示不应该触碰 core。
 */

/** 区域名 —— 按 `docs/06` B2 布局原文用词。 */
export const ZONE_LABEL: Readonly<Record<Zone, string>> = {
  deck: '卡组区',
  hand: '手牌',
  commander: '指挥官',
  board: '随从区',
  spell: '法术区',
  cost: '费用区',
  graveyard: '弃牌区',
  exile: '除外区',
  reveal: '展示区',
};

/**
 * 阶段名 —— 按 `docs/06` A4-1 六阶段。
 *
 * ⚠️ 「抽牌」：Era 于 2026-10-13 确认 A4-1 原文写的「**抽排**阶段」是**笔误**，
 * 正确用词为「抽牌阶段」。代码与文档均已统一更正。
 */
export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  charge: '充能',
  reset: '重置',
  draw: '抽牌',
  main: '主要',
  battle: '战斗',
  end: '结束',
};

/**
 * 关键词注释 —— 卡牌详情浮层用（Era 2026-10-18：卡牌携带效果必须可查看）。
 * 文案照抄 `docs/06` A7 表的已填行；新增关键词 = A7 表 + 本表各加一行。
 */
export const KEYWORD_NOTE: Readonly<Record<string, string>> = {
  taunt: '嘲讽：对手随从攻击时必须优先选择此目标',
};

/**
 * 回合时限档位的中文标签（H18）。
 *
 * ⚠️ 新增档位要**同时**改 `shared/constants.ts` 的 `TURN_TIMEOUT_OPTIONS` 与本表，
 * 否则下拉里会出现「120 秒」这种没有修饰语的裸值（兜底不会崩，但读起来像漏了东西）。
 */
const TURN_TIMEOUT_LABEL: Readonly<Record<number, string>> = {
  30_000: '30 秒（快节奏）',
  60_000: '60 秒（默认）',
  180_000: '180 秒（3 分钟）',
  999_000: '999 秒（基本不限时）',
};

/** 档位 → 下拉文案；未知档位回落成「N 秒」。 */
export function turnTimeoutLabel(ms: number): string {
  return TURN_TIMEOUT_LABEL[ms] ?? `${Math.round(ms / 1000)} 秒`;
}

/**
 * 对局成因文案 —— P-02 / D-238。
 *
 * ## 为什么按「我赢了没」分两套
 *
 * 同一句「败北」有四种成因，而玩家真正想知道的是**我这局是怎么没的**。
 * `game:ended.reason` 是中性事实（`health` / `concede` / `opponent-left` …），
 * 直接印在结算页上等于让玩家自己翻译；按视角说完才是一句人话。
 *
 * ## 为什么未知成因要兜底
 *
 * 旧回放里的 `reason` 可能不在表内（更早版本写的是 `'draw'` 之外的自由串）。
 * 结算页宁可少说一句，也不该显示 `undefined` 或干脆崩掉。
 */
const END_REASON_TEXT: Readonly<Record<string, { win: string; lose: string }>> = {
  health: { win: '对方指挥官生命归零', lose: '你的指挥官生命归零' },
  'sudden-death': {
    win: '即死模式：对方掉血即判负',
    lose: '即死模式：你掉血即判负',
  },
  'turn-limit': {
    win: '40 轮结束，你的指挥官血量更高',
    lose: '40 轮结束，对方指挥官血量更高',
  },
  concede: { win: '对手认输', lose: '你已认输' },
  'opponent-left': { win: '对手离开或掉线超时', lose: '你离开或掉线超时' },
};

/**
 * 结算面板的成因行。
 *
 * @param reason `GameState.endReason`；老回放可能为 `null`
 * @param draw   `GameState.draw` —— 判和时成因固定一句话，与胜负无关
 * @param iWon   我方是否获胜（`winner === me`）
 * @returns 说完的一整句；无法判断时返回 `null`（调用方据此少渲染一行）
 */
export function endReasonText(reason: string | null, draw: boolean, iWon: boolean): string | null {
  if (draw || reason === 'draw') return '40 轮未分胜负';
  if (!reason) return null;
  const row = END_REASON_TEXT[reason];
  return row ? (iWon ? row.win : row.lose) : null;
}

/**
 * 断线横幅文案（D-255）。
 *
 * socket.io 在未连接时 `emit` 会静默排队 —— 界面上就是「点了没反应」。
 * 只要不是 `online` 就一律说清楚，返回 `null` 表示不用挂横幅。
 */
export function linkBannerText(link: 'connecting' | 'online' | 'offline'): string | null {
  if (link === 'online') return null;
  if (link === 'connecting') return '正在连接服务器… —— 连上后可继续操作';
  return '与服务器断开，操作已暂停 —— 正在自动重连';
}
