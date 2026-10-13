/**
 * 卡组构成校验 —— `docs/06` A6-5 + ADR-0012 补充（31 = 主卡组 30 + 指挥官 1）。
 *
 * 校验**分别校验构成**而非只校验总数：总数对但构成错（例如 31 张里没有指挥官）
 * 必须被拒绝，否则后面每一步都会踩到「指挥官不存在」的分支上。
 */

import {
  MAIN_DECK_SIZE,
  MAX_COPIES,
  type CardDef,
  type PlayerState,
} from '@app/shared';

/** 返回 null 表示合法；否则返回人话原因（直接给玩家看的提示文案）。 */
export function checkDeck(p: PlayerState, cards: Record<string, CardDef>): string | null {
  const deck = p.zones.deck;

  if (deck.length !== MAIN_DECK_SIZE) {
    return `主卡组应为 ${MAIN_DECK_SIZE} 张，实际 ${deck.length} 张`;
  }

  const cmd = cards[p.commanderDefId];
  if (!cmd) return `指挥官卡定义缺失: ${p.commanderDefId || '(空)'}`;
  if (cmd.type !== 'commander') return `指挥官卡类型应为 commander，实际 ${cmd.type}`;

  const copies = new Map<string, number>();
  for (const c of deck) {
    const def = cards[c.defId];
    if (!def) return `卡定义缺失: ${c.defId}`;
    if (def.type === 'commander') return `主卡组内不得含指挥官卡: ${c.defId}`;
    copies.set(c.defId, (copies.get(c.defId) ?? 0) + 1);
  }
  for (const [defId, n] of copies) {
    if (n > MAX_COPIES) return `同名卡不得超过 ${MAX_COPIES} 张: ${defId}（实际 ${n}）`;
  }
  return null;
}
