import { CARD_POOL } from './cards.js';
import { MAIN_DECK_SIZE, MAX_COPIES } from './constants.js';

/**
 * 三套基础卡组 —— **客户端编辑器的默认内容** 与 **服务端未选卡组时的回退** 共用这一份配方。
 *
 * 背景（D-169）：这三套配方原本只存在于 `server/src/deck-pool.ts`，客户端拿不到，
 * 所以进入「编辑卡组」时永远是空白列表，玩家得从 45 张里手动凑 30 张。
 * 迁到 shared 后两边同源：服务端按卡组装配，客户端首次进入直接预置成可玩的卡组。
 *
 * ⚠️ 这里是**数据**不是规则：配方改动只影响默认内容，不影响任何结算逻辑。
 * 合法性由 `deckRecipeProblems()` 校验，单测钉住三套各 30 张。
 *
 * ⚠️ 本文件**不得** import `./schema.js` / `./index.js` —— 客户端要按子路径引入，
 * 走根入口会把 zod 拖进首屏产物（实测约 24 kB gzip）。
 *
 * ## 2026-10-20：没有「阵营」了（D-184 / ADR-0042）
 *
 * Era：「我的设计里不存在阵营之分，卡池可以混选……根据卡组选择就行了。」
 * 于是这里不再有 `Faction` 类型，`slug` 只是**标识与配色用的短名**，
 * 不参与任何校验、也不限制能放哪些卡 —— 一套卡组可以混三系。
 * 每个玩家提交的就是「30 张主卡 + 1 位指挥官」。
 */

/** 炎刃指挥官。 */
export const DEFAULT_COMMANDER_ID = 'bladeLord';
/** 霜律指挥官。 */
export const FROST_COMMANDER_ID = 'frostAdjudicator';
/** 星轨指挥官（docs/17 §3）。 */
export const STAR_COMMANDER_ID = 'starWatcher';

/**
 * 三位指挥官 —— 卡组编辑页的候选人列表（顺序即界面顺序）。
 *
 * 单一来源：这里列出的 `defId` 必须都在 `CARD_POOL` 里且 `type === 'commander'`，
 * 由 `deck-pool.test.ts` 钉住，避免加卡时两处不同步。
 */
export const COMMANDER_IDS: readonly string[] = [
  DEFAULT_COMMANDER_ID,
  FROST_COMMANDER_ID,
  STAR_COMMANDER_ID,
];

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

/** 基础卡组的短名（仅作标识：localStorage 键、样式、日志可读性）—— **不是阵营**。 */
export type BasicDeckSlug = 'blade' | 'frost' | 'star';

/** 一套「主卡组 + 指挥官」的基础卡组。 */
export interface BasicDeck {
  readonly slug: BasicDeckSlug;
  /** 展示名，来自 docs 的卡组标题。 */
  readonly name: string;
  readonly commander: string;
  readonly recipe: Readonly<Record<string, number>>;
  readonly deck: readonly string[];
}

/** 三套基础卡组，按界面顺序排列 —— 服务端回退与客户端预置都走这里。 */
export const BASIC_DECKS: readonly BasicDeck[] = [
  {
    slug: 'blade',
    name: '炎刃 · 中速除外',
    commander: DEFAULT_COMMANDER_ID,
    recipe: BLADE_MAIN_DECK_RECIPE,
    deck: DEFAULT_MAIN_DECK,
  },
  {
    slug: 'frost',
    name: '霜律 · 冻结控制',
    commander: FROST_COMMANDER_ID,
    recipe: FROST_MAIN_DECK_RECIPE,
    deck: FROST_MAIN_DECK,
  },
  {
    slug: 'star',
    name: '星轨 · 展示引擎',
    commander: STAR_COMMANDER_ID,
    recipe: STAR_MAIN_DECK_RECIPE,
    deck: STAR_MAIN_DECK,
  },
];

/** 按短名取一套基础卡组（客户端把选择存成 `basic:<slug>`）。 */
export function basicDeckBySlug(slug: string): BasicDeck | undefined {
  return BASIC_DECKS.find((d) => d.slug === slug);
}

/**
 * 按指挥官找一套匹配的基础卡组。
 *
 * 用途：玩家只交了主卡组、没交指挥官（老客户端 / 手改 localStorage），
 * 或反过来说只选了指挥官没交卡组 —— 服务端要能**确定地**补另一半，
 * 而不是随手拿第一套（那会让「选了霜律指挥官却拿到炎刃 30 张」这种错配静默发生）。
 */
export function basicDeckOfCommander(commanderId: string): BasicDeck | undefined {
  return BASIC_DECKS.find((d) => d.commander === commanderId);
}

/**
 * 校验一份配方能否直接当主卡组用；返回**给人看的**问题列表，空数组表示合法。
 *
 * 只检查已被规则确认的四件事（与服务端 `validateDeckList`、core `checkDeck` 同口径）：
 * 总张数、同名上限、不含指挥官、`defId` 必须存在。
 * **不检查**三系混搭 —— Era 2026-10-20：「不存在阵营之分，卡池可以混选」（ADR-0042）。
 */
export function deckRecipeProblems(recipe: Readonly<Record<string, number>>): string[] {
  const problems: string[] = [];
  let total = 0;
  for (const [defId, n] of Object.entries(recipe)) {
    const def = CARD_POOL[defId];
    if (!def) {
      problems.push(`卡组里有未知卡牌：${defId}`);
      continue;
    }
    if (def.type === 'commander') problems.push(`主卡组不能包含指挥官：${def.name}`);
    if (n > MAX_COPIES) problems.push(`${def.name} 超过同名上限 ${MAX_COPIES} 张（当前 ${n} 张）`);
    total += n;
  }
  if (total !== MAIN_DECK_SIZE) {
    problems.push(`主卡组应为 ${MAIN_DECK_SIZE} 张，当前 ${total} 张`);
  }
  return problems;
}
