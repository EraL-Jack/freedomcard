import type { CardDef } from '@app/shared';

/**
 * 卡池（卡定义表）。
 *
 * ⚠️ **当前为空，且这是刻意的** —— `TODO(slot)`：`docs/06` A6-3 字段清单与 A7 关键词
 * 均标注「后续补充」，Era 说明会另行给出卡池数据。在拿到真实数据前**不得编造卡牌**，
 * 否则等于替 Era 发明玩法（`docs/01` §9 明令禁止）。
 *
 * 空卡池的后果是安全的：规则处理器查不到卡定义时会返回 `CARD_NOT_FOUND` 拒绝，
 * 不会静默放行 —— 宁可跑不动，也不能跑出一套假卡。
 */
export const CARD_POOL: Record<string, CardDef> = {};
