import type { PlayerId } from '@app/shared';

/**
 * Demo 用默认卡组 —— ADR-0018 / ADR-0025。
 *
 * 两套 **合法**的主卡组（30 张 + 指挥官 1 张），来自 `docs/12` §8：
 *  - `BLADE_MAIN_DECK`：炎刃 · 中速除外（指挥官 `bladeLord`）；
 *  - `FROST_MAIN_DECK`：霜律 · 冻结控制（指挥官 `frostAdjudicator`）。
 *
 * ## 为什么两套
 *
 * 卡池已扩到 30 张双阵营（ADR-0025），若两端都用同一套，霜律的 15 张永远不出场，
 * 联机 Demo 无法验收冰霜体系。`defaultDeckSetup` 按座位序分配：第 1 位炎刃、
 * 第 2 位霜律 —— 这不是对战平衡设计，只是让一局里两个体系都能被看到。
 *
 * 📌 卡组编辑（B1）落地后，本文件即可整体删除。
 */

/** 炎刃指挥官 —— 卡池中第一个 `type === 'commander'` 的炎刃卡。 */
export const DEFAULT_COMMANDER_ID = 'bladeLord';
/** 霜律指挥官。 */
export const FROST_COMMANDER_ID = 'frostAdjudicator';

/** `docs/12` §8.1 炎刃 · 中速除外（合计 30）。 */
export const BLADE_MAIN_DECK_RECIPE: Readonly<Record<string, number>> = {
  bladeScout: 3,
  bladeRecruit: 2,
  bladeVanguard: 3,
  bladeTactician: 2,
  bladeOrder: 2,
  bladeGuard: 3,
  bladeTactics: 1,
  bladeCremation: 2,
  bladeKnight: 3,
  bladeBanner: 2,
  bladeCaptain: 2,
  bladeVeteran: 2,
  bladeChampion: 2,
  bladePhoenix: 1,
};

/** `docs/12` §8.2 霜律 · 冻结控制（合计 30）。 */
export const FROST_MAIN_DECK_RECIPE: Readonly<Record<string, number>> = {
  frostRecruit: 2,
  frostApprentice: 3,
  frostWarden: 3,
  frostEdict: 2,
  frostBinder: 3,
  frostLancer: 3,
  frostColdSnap: 1,
  frostEnforcer: 2,
  frostDomain: 2,
  frostNightwatch: 2,
  frostJailer: 2,
  frostJudgment: 2,
  frostFinalJudgment: 1,
  frostWinterblade: 2,
};

/** 展开为 `defId` 列表（顺序即初始牌序；洗牌在开局时做）。 */
function expand(recipe: Readonly<Record<string, number>>): readonly string[] {
  return Object.entries(recipe).flatMap(([defId, n]) => Array.from({ length: n }, () => defId));
}

export const DEFAULT_MAIN_DECK: readonly string[] = expand(BLADE_MAIN_DECK_RECIPE);
export const FROST_MAIN_DECK: readonly string[] = expand(FROST_MAIN_DECK_RECIPE);

/**
 * 为在座玩家生成「主卡组 + 指挥官」。
 *
 * 按座位序交替分配两套卡组（0 → 炎刃，1 → 霜律，2 → 炎刃…）。
 * 正式卡组来源应是卡组编辑（B1：支持多个卡组保存）。
 */
export function defaultDeckSetup(seats: readonly PlayerId[]): {
  decks: Record<PlayerId, readonly string[]>;
  commanders: Record<PlayerId, string>;
} {
  const decks: Record<PlayerId, readonly string[]> = {};
  const commanders: Record<PlayerId, string> = {};
  seats.forEach((id, i) => {
    const blade = i % 2 === 0;
    decks[id] = blade ? DEFAULT_MAIN_DECK : FROST_MAIN_DECK;
    commanders[id] = blade ? DEFAULT_COMMANDER_ID : FROST_COMMANDER_ID;
  });
  return { decks, commanders };
}
