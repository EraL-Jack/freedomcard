/**
 * 默认卡组 —— **配方与阵营映射已迁至 `@app/shared/src/default-decks.ts`**（D-169）。
 *
 * 迁移理由：这份数据要被**两端消费** —— 服务端用它装配未选卡组时的回退，
 * 客户端用它预置「三套基础卡组」。它与 `cards.ts` 同理，属于数据而非玩法规则，
 * 放共享层不违反「不发明需求」的纪律。
 *
 * 本文件只保留**服务端职责**：按座位与阵营把卡组分配给玩家。
 * 其余导出仅作 re-export，以免打断既有 import 路径（`../deck-pool.js`）与测试调用点。
 */

import type { Faction, PlayerId } from '@app/shared';
import { CARD_POOL } from '@app/shared/cards';
import { MAIN_DECK_SIZE, MAX_COPIES } from '@app/shared/constants';

import { FACTION_DECKS } from '@app/shared/default-decks';

export * from '@app/shared/default-decks';

/**
 * 校验客户端提交的主卡组（D-141）。
 *
 * 返回 `null` = 合法；否则返回**直接给玩家看的人话原因**。
 *
 * 与 `core.checkDeck` 同口径（30 张 / 同名 ≤3 / 不含指挥官 / 卡必须存在），
 * 区别是这里校验的是「刚收到的 defId 列表」，还没装配成 `PlayerState`。
 * 卡组只含主卡组：指挥官仍由席位阵营决定。
 */
export function validateDeckList(defIds: readonly string[]): string | null {
  if (defIds.length !== MAIN_DECK_SIZE) {
    return `主卡组应为 ${MAIN_DECK_SIZE} 张，当前 ${defIds.length} 张`;
  }
  const copies = new Map<string, number>();
  for (const id of defIds) {
    const def = CARD_POOL[id];
    if (!def) return `卡组里有未知卡牌：${id}`;
    if (def.type === 'commander') return `主卡组不能包含指挥官：${def.name}`;
    copies.set(id, (copies.get(id) ?? 0) + 1);
  }
  for (const [id, n] of copies) {
    if (n > MAX_COPIES) {
      return `同名卡不得超过 ${MAX_COPIES} 张：${CARD_POOL[id]?.name ?? id}（当前 ${n} 张）`;
    }
  }
  return null;
}

/** 座位轮换默认阵营（未显式选择时）。 */
const ROTATION: readonly Faction[] = ['blade', 'frost', 'star'];

/**
 * 为在座玩家生成「主卡组 + 指挥官」。
 *
 * `factions` 缺省时按座位序轮换（0 炎刃、1 霜律、2 星轨）。
 * 玩家显式选了卡组时走 `session.ts` 的另一条分支，这里只负责回退。
 */
export function defaultDeckSetup(
  seats: readonly PlayerId[],
  factions: Readonly<Record<PlayerId, Faction>> = {},
): {
  decks: Record<PlayerId, readonly string[]>;
  commanders: Record<PlayerId, string>;
} {
  const decks: Record<PlayerId, readonly string[]> = {};
  const commanders: Record<PlayerId, string> = {};
  seats.forEach((id, i) => {
    const faction = factions[id] ?? ROTATION[i % ROTATION.length]!;
    const set = FACTION_DECKS[faction]!;
    decks[id] = set.deck;
    commanders[id] = set.commander;
  });
  return { decks, commanders };
}
