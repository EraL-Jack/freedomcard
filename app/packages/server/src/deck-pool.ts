import type { PlayerId } from '@app/shared';

/**
 * Demo 用默认卡组 —— ADR-0018。
 *
 * ## 这是占位数据，不是 Era 的卡表
 *
 * Era 于 2026-10-13 授权「其他卡组内容先由你生成补充完整」，据此补齐：
 *  - `cards.ts` 中新增 8 张**纯数值**占位卡（无 `text`、无新关键词）；
 *  - 本文件给出一套 **30 张的 Demo 主卡组**，供开局桥直接调用。
 *
 * ⚠️ 为什么单独成文件：**把「卡池」与「这局用什么牌」分开**。
 *  `CARD_POOL` 回答「卡是什么」，`DEFAULT_MAIN_DECK` 回答「这局用什么」——
 *  后者随时可换，前者随 Era 的输入增长。混在一起会让「换一套牌试试」
 *  变成改卡池，进而污染「哪些卡是 Era 给的」这条边界。
 *
 * 📌 Era 给正式卡表 / 卡组编辑（B1）落地后，本文件即可整体删除。
 */

/**
 * 每位玩家使用的指挥官。
 *
 * 卡池里**有且仅有**一张 `type === 'commander'` 的卡（`bladeLord`），
 * 故这里没有第二个可选值 —— 这不是「默认挑一个」，而是唯一合法解。
 */
export const DEFAULT_COMMANDER_ID = 'bladeLord';

/**
 * Demo 主卡组的**构成**（`defId` → 张数），合计 30 张。
 *
 * 配比逻辑：低费牌多带（保证前几回合有牌可出），高费牌少带（避免卡手）。
 * 这只是让 Demo 能开局跑通的**占位配比**，不代表正式构筑思路。
 */
export const DEFAULT_MAIN_DECK_RECIPE: Readonly<Record<string, number>> = {
  bladeScout: 3,
  bladeRecruit: 3,
  bladeVanguard: 3,
  bladeTactician: 3,
  bladeOrder: 3,
  bladeGuard: 3,
  bladeTactics: 3,
  bladeKnight: 2,
  bladeBanner: 2,
  bladeCaptain: 2,
  bladeVeteran: 2,
  bladeChampion: 1,
};

/** 展开为 `defId` 列表（顺序即初始牌序；真正的洗牌在开局时由引擎做）。 */
export const DEFAULT_MAIN_DECK: readonly string[] = Object.entries(DEFAULT_MAIN_DECK_RECIPE).flatMap(
  ([defId, n]) => Array.from({ length: n }, () => defId),
);

/**
 * 为所有在座玩家生成「主卡组 + 指挥官」。
 *
 * 当前所有玩家共用同一套占位卡组 —— 这只是 Demo 阶段的权宜之计，
 * 正式的卡组来源应是卡组编辑（B1 要求「支持多个卡组保存」）。
 */
export function defaultDeckSetup(seats: readonly PlayerId[]): {
  decks: Record<PlayerId, readonly string[]>;
  commanders: Record<PlayerId, string>;
} {
  const decks: Record<PlayerId, readonly string[]> = {};
  const commanders: Record<PlayerId, string> = {};
  for (const id of seats) {
    decks[id] = DEFAULT_MAIN_DECK;
    commanders[id] = DEFAULT_COMMANDER_ID;
  }
  return { decks, commanders };
}
