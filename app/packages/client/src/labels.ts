import type { Phase, Zone } from '@app/shared';

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
