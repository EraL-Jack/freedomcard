import type { Faction, PlayerId } from '@app/shared';

/**
 * Demo 用默认卡组 —— ADR-0018 / ADR-0025 / D-235。
 *
 * 三套 **合法**的主卡组（30 张 + 指挥官 1 张）：
 *  - `blade`：炎刃 · 中速除外（指挥官 `bladeLord`），`docs/12` §8.1；
 *  - `frost`：霜律 · 冻结控制（指挥官 `frostAdjudicator`），`docs/12` §8.2；
 *  - `star`：星轨 · 展示引擎（指挥官 `starWatcher`），`docs/17` §7。
 *
 * ## 为什么三套
 *
 * 卡池已扩到三阵营 45 张（D-230）。阵营由玩家在**建房 / 加入时选择**（D-235），
 * 未选择时按座位轮换（0 炎刃、1 霜律、2 星轨）—— 这不是对战平衡设计，
 * 只是让联机 Demo 里两套不同体系都能被看到。
 *
 * 📌 卡组编辑（B1）落地后，本文件即可整体删除。
 */

/** 炎刃指挥官。 */
export const DEFAULT_COMMANDER_ID = 'bladeLord';
/** 霜律指挥官。 */
export const FROST_COMMANDER_ID = 'frostAdjudicator';
/** 星轨指挥官（docs/17 §3）。 */
export const STAR_COMMANDER_ID = 'starWatcher';

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

/** `docs/17` §7 星轨 · 展示引擎（合计 30）。 */
export const STAR_MAIN_DECK_RECIPE: Readonly<Record<string, number>> = {
  starScout: 3,
  starAcolyte: 3,
  starArcher: 3,
  starGuard: 3,
  starWeaver: 3,
  starChart: 2,
  starFall: 2,
  starGaze: 2,
  starLancer: 2,
  starHerald: 2,
  starBlessing: 1,
  starGiant: 2,
  starOrbit: 1,
  starSovereign: 1,
};

/** 展开为 `defId` 列表（顺序即初始牌序；洗牌在开局时做）。 */
function expand(recipe: Readonly<Record<string, number>>): readonly string[] {
  return Object.entries(recipe).flatMap(([defId, n]) => Array.from({ length: n }, () => defId));
}

export const DEFAULT_MAIN_DECK: readonly string[] = expand(BLADE_MAIN_DECK_RECIPE);
export const FROST_MAIN_DECK: readonly string[] = expand(FROST_MAIN_DECK_RECIPE);
export const STAR_MAIN_DECK: readonly string[] = expand(STAR_MAIN_DECK_RECIPE);

/** 一套阵营的「主卡组 + 指挥官」。 */
export interface FactionDeck {
  readonly commander: string;
  readonly deck: readonly string[];
  readonly recipe: Readonly<Record<string, number>>;
}

/** 三个阵营各一套 —— 会话层按席位阵营取用。 */
export const FACTION_DECKS: Readonly<Record<Faction, FactionDeck>> = {
  blade: { commander: DEFAULT_COMMANDER_ID, deck: DEFAULT_MAIN_DECK, recipe: BLADE_MAIN_DECK_RECIPE },
  frost: { commander: FROST_COMMANDER_ID, deck: FROST_MAIN_DECK, recipe: FROST_MAIN_DECK_RECIPE },
  star: { commander: STAR_COMMANDER_ID, deck: STAR_MAIN_DECK, recipe: STAR_MAIN_DECK_RECIPE },
};

/** 座位轮换默认阵营（未显式选择时）。 */
const ROTATION: readonly Faction[] = ['blade', 'frost', 'star'];

/**
 * 为在座玩家生成「主卡组 + 指挥官」。
 *
 * `factions` 缺省时按座位序轮换（0 炎刃、1 霜律、2 星轨）。
 * 正式卡组来源应是卡组编辑（B1：支持多个卡组保存）。
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
