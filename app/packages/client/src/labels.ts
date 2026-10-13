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

/** 阶段名 —— 按 `docs/06` A4-1 六阶段。 */
export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  charge: '充能',
  reset: '重置',
  draw: '抽排',
  main: '主要',
  battle: '战斗',
  end: '结束',
};
