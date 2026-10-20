/**
 * 默认卡组 —— **配方与基础卡组定义已迁至 `@app/shared/src/default-decks.ts`**（D-169）。
 *
 * 迁移理由：这份数据要被**两端消费** —— 服务端用它装配未选卡组时的回退，
 * 客户端用它预置「三套基础卡组」。它与 `cards.ts` 同理，属于数据而非玩法规则，
 * 放共享层不违反「不发明需求」的纪律。
 *
 * 本文件只保留**服务端职责**：校验玩家提交的「主卡组 + 指挥官」，并在缺省时补默认。
 * 其余导出仅作 re-export，以免打断既有 import 路径（`../deck-pool.js`）与测试调用点。
 */

import type { PlayerId } from '@app/shared';
import { CARD_POOL } from '@app/shared/cards';
import { MAIN_DECK_SIZE, MAX_COPIES } from '@app/shared/constants';

import { BASIC_DECKS, basicDeckOfCommander } from '@app/shared/default-decks';

export * from '@app/shared/default-decks';

/**
 * 校验客户端提交的主卡组（D-141）。
 *
 * 返回 `null` = 合法；否则返回**直接给玩家看的人话原因**。
 *
 * 与 `core.checkDeck` 同口径（30 张 / 同名 ≤3 / 不含指挥官 / 卡必须存在），
 * 区别是这里校验的是「刚收到的 defId 列表」，还没装配成 `PlayerState`。
 * 卡组只含主卡组；指挥官是**另一个字段**，见 `validateCommander`。
 *
 * ⚠️ **不校验三系混搭** —— Era 2026-10-20 定「不存在阵营之分，卡池可以混选」（ADR-0042）。
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

/**
 * 校验指挥官（D-184）—— 必须是卡池里 `type === 'commander'` 的那几张之一。
 *
 * 返回 `null` = 合法。为什么不复用 `checkDeck`：指挥官不是「卡组里的一张」，
 * 错误文案也不一样（「X 不是指挥官」而不是「主卡组不能包含指挥官」）。
 */
export function validateCommander(defId: string): string | null {
  const def = CARD_POOL[defId];
  if (!def) return `未知的指挥官：${defId}`;
  if (def.type !== 'commander') return `${def.name} 不是指挥官`;
  return null;
}

/**
 * 为在座玩家生成「主卡组 + 指挥官」。
 *
 * 规则（ADR-0042）：每个玩家提交的是**一整套**（30 张 + 1 位指挥官）。
 * 这里只负责**缺省时的确定性回退**，不做任何「轮换」：
 *
 * | 玩家给了什么 | 结果 |
 * | --- | --- |
 * | 指挥官 + 卡组 | 原样使用（`session.ts` 里覆盖，本函数只出默认值） |
 * | 只给指挥官 | 该指挥官自带的那套 30 张 |
 * | 只给卡组 | 第一套基础卡组的指挥官 |
 * | 都没给 | 第一套基础卡组（炎刃） |
 *
 * ⚠️ 不要退回「按座位轮换三套」—— 那是阵营时代的产物，会让两席**默认**不同；
 * 现在的模型里，默认就该是同一套可预测的卡组，差异只来自玩家自己的选择。
 */
export function defaultDeckSetup(
  seats: readonly PlayerId[],
  commanders: Readonly<Record<PlayerId, string>> = {},
): {
  decks: Record<PlayerId, readonly string[]>;
  commanders: Record<PlayerId, string>;
} {
  const decks: Record<PlayerId, readonly string[]> = {};
  const resolved: Record<PlayerId, string> = {};
  for (const id of seats) {
    const chosen = commanders[id];
    // 指定了指挥官 → 用它自带的那套；没指定 / 不认识 → 第一套基础卡组。
    const set = (chosen ? basicDeckOfCommander(chosen) : undefined) ?? BASIC_DECKS[0]!;
    decks[id] = set.deck;
    resolved[id] = chosen ?? set.commander;
  }
  return { decks, commanders: resolved };
}
